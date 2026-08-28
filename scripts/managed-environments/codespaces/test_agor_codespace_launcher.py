import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agor_codespace_launcher import (
    CodespaceController,
    GitHubCodespacesClient,
    LauncherError,
    StateStore,
    access_urls,
    marker_for,
    redact,
    validate_resource,
)

REPOSITORY = "preset-io/agor"
REF = "codespaces-sqlite-variant"
BINDING = "01999999-1111-7222-8333-444444444444"


def resource(
    name="octocat-agor-new123",
    *,
    state="Available",
    owner="octocat",
    repository=REPOSITORY,
    ref=REF,
    marker=None,
):
    return {
        "name": name,
        "display_name": marker or marker_for(REPOSITORY, BINDING),
        "state": state,
        "owner": {"login": owner},
        "repository": {"full_name": repository, "id": 123},
        "git_status": {"ref": ref},
        "web_url": f"https://{name}.github.dev",
    }


def ports(name="octocat-agor-new123"):
    return [
        {
            "sourcePort": 3000,
            "visibility": "private",
            "label": "Agor daemon",
            "browseUrl": f"https://{name}-3000.app.github.dev",
        },
        {
            "sourcePort": 5000,
            "visibility": "private",
            "label": "Agor UI",
            "browseUrl": f"https://{name}-5000.app.github.dev",
        },
    ]


class FakeClient:
    def __init__(self, resources=None):
        self.resources = list(resources or [])
        self.created = 0
        self.started = []
        self.stopped = []
        self.deleted = []
        self.creation_log_calls = []
        self.runtime_log_calls = []

    def viewer(self):
        return "octocat"

    def repository(self, repository):
        return {"full_name": repository, "id": 123}

    def resolve_ref(self, repository, ref):
        return "a" * 40

    def list_codespaces(self, repository):
        return list(self.resources)

    def create_codespace(self, repository, ref, display_name, *_args):
        self.created += 1
        created = resource(marker=display_name, repository=repository, ref=ref)
        self.resources.append(created)
        return created

    def get_codespace(self, name):
        return next(item for item in self.resources if item["name"] == name)

    def start_codespace(self, name):
        self.started.append(name)
        for item in self.resources:
            if item["name"] == name:
                item["state"] = "Available"

    def stop_codespace(self, name):
        self.stopped.append(name)
        for item in self.resources:
            if item["name"] == name:
                item["state"] = "Shutdown"

    def delete_codespace(self, name):
        self.deleted.append(name)
        self.resources = [item for item in self.resources if item["name"] != name]

    def list_ports(self, name):
        return ports(name)

    def remote_health(self, _name, _port):
        return True

    def creation_logs(self, name):
        self.creation_log_calls.append(name)
        return "safe creation log\n"

    def runtime_logs(self, name, _repository):
        self.runtime_log_calls.append(name)
        return "safe runtime log\n"


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.temp.name), REPOSITORY, BINDING)

    def tearDown(self):
        self.temp.cleanup()

    def controller(self, client, *, monotonic=None):
        return CodespaceController(
            client=client,
            store=self.store,
            repository=REPOSITORY,
            ref=REF,
            binding=BINDING,
            devcontainer_path=".devcontainer/agor-managed/devcontainer.json",
            idle_timeout_minutes=30,
            retention_period_minutes=1440,
            app_port=5000,
            health_port=3000,
            wait_seconds=30,
            sleep=lambda _seconds: None,
            **({"monotonic": monotonic} if monotonic is not None else {}),
        )

    def test_start_creates_exact_repo_ref_then_persists_non_secret_binding(self):
        client = FakeClient()
        created, discovered_ports = self.controller(client).start()

        self.assertEqual(client.created, 1)
        self.assertEqual(created["repository"]["full_name"], REPOSITORY)
        self.assertEqual(created["git_status"]["ref"], REF)
        self.assertEqual(
            {item["sourcePort"] for item in discovered_ports}, {3000, 5000}
        )
        state = self.store.load()
        self.assertEqual(state["owner"], "octocat")
        self.assertEqual(state["name"], created["name"])
        self.assertEqual(state["created_ref_sha"], "a" * 40)
        self.assertNotIn("token", json.dumps(state).lower())

    def test_second_start_rediscovers_instead_of_creating_a_duplicate(self):
        existing = resource()
        client = FakeClient([existing])
        controller = self.controller(client)

        controller.start()
        controller.start()

        self.assertEqual(client.created, 0)

    def test_stopped_codespace_is_resumed_and_revalidated(self):
        existing = resource(state="Shutdown")
        client = FakeClient([existing])

        ready, _ = self.controller(client).start()

        self.assertEqual(client.started, [existing["name"]])
        self.assertEqual(ready["state"], "Available")

    def test_recreated_resource_replaces_a_stale_name_after_discovery(self):
        old = resource(name="octocat-agor-old123")
        self.store.save(
            {
                "version": 1,
                "binding": BINDING,
                "repository": REPOSITORY,
                "ref": REF,
                "owner": "octocat",
                "name": old["name"],
                "display_name": marker_for(REPOSITORY, BINDING),
            }
        )
        new = resource(name="octocat-agor-new999")

        ready, _ = self.controller(FakeClient([new])).start()

        self.assertEqual(ready["name"], new["name"])
        self.assertEqual(self.store.load()["name"], new["name"])

    def test_duplicate_marker_is_ambiguous_and_fails_closed(self):
        client = FakeClient(
            [resource(name="octocat-agor-one111"), resource(name="octocat-agor-two222")]
        )

        with self.assertRaisesRegex(LauncherError, "ambiguous"):
            self.controller(client).start()
        self.assertEqual(client.created, 0)

    def test_actor_change_is_blocked_before_remote_mutation(self):
        existing = resource()
        self.store.save(
            {
                "version": 1,
                "binding": BINDING,
                "repository": REPOSITORY,
                "ref": REF,
                "owner": "someone-else",
                "name": existing["name"],
                "display_name": marker_for(REPOSITORY, BINDING),
            }
        )
        client = FakeClient([existing])

        with self.assertRaisesRegex(LauncherError, "another GitHub actor"):
            self.controller(client).start()
        self.assertEqual(client.created, 0)

    def test_stop_and_nuke_are_idempotent(self):
        client = FakeClient()
        controller = self.controller(client)
        self.assertIsNone(controller.stop())
        self.assertFalse(controller.nuke())

        existing = resource()
        client.resources.append(existing)
        stopped = controller.stop()
        self.assertEqual(stopped["state"], "Shutdown")
        self.assertTrue(controller.nuke())
        self.assertEqual(client.deleted, [existing["name"]])
        self.assertIsNone(self.store.load())

    def test_destructive_action_refetches_and_freezes_on_identity_drift(self):
        existing = resource()
        client = FakeClient([existing])
        drifted = resource(name=existing["name"], marker="renamed-outside-agor")
        client.get_codespace = lambda _name: drifted

        with self.assertRaisesRegex(LauncherError, "binding marker"):
            self.controller(client).nuke()
        self.assertEqual(client.deleted, [])

    def test_logs_never_wake_a_stopped_codespace(self):
        existing = resource(state="Shutdown")
        client = FakeClient([existing])

        output = self.controller(client).logs()

        self.assertIn("would resume a stopped Codespace", output)
        self.assertEqual(client.creation_log_calls, [])
        self.assertEqual(client.runtime_log_calls, [])

    def test_mismatched_repo_ref_owner_or_marker_is_never_adopted(self):
        cases = [
            resource(owner="mallory"),
            resource(repository="another/repo"),
            resource(ref="another-branch"),
            resource(marker="not-this-branch"),
        ]
        for candidate in cases:
            with self.subTest(candidate=candidate):
                with self.assertRaises(LauncherError):
                    validate_resource(
                        candidate,
                        owner="octocat",
                        repository=REPOSITORY,
                        repository_id=123,
                        ref=REF,
                        marker=marker_for(REPOSITORY, BINDING),
                    )

    def test_dynamic_app_and_editor_urls_come_from_validated_resource(self):
        existing = resource()
        self.assertEqual(
            access_urls(existing, ports(existing["name"]), 5000),
            [
                {
                    "name": "App",
                    "url": f"https://{existing['name']}-5000.app.github.dev",
                },
                {"name": "Codespace", "url": existing["web_url"]},
            ],
        )
        bad_ports = ports(existing["name"])
        bad_ports[1]["browseUrl"] = "https://evil.example.test/steal"
        with self.assertRaisesRegex(LauncherError, "safe browse URL"):
            access_urls(existing, bad_ports, 5000)

    def test_preview_readiness_has_a_bounded_timeout(self):
        existing = resource()
        client = FakeClient([existing])
        client.list_ports = lambda _name: []
        ticks = iter((0, 31, 62))

        with self.assertRaisesRegex(LauncherError, "timed out after 30s"):
            self.controller(client, monotonic=lambda: next(ticks)).start()

    def test_redaction_removes_common_credentials(self):
        value = (
            "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456 "
            "token=github_pat_abcdefghijklmnopqrstuvwxyz DATABASE_PASSWORD=hunter2"
        )
        sanitized = redact(value)
        self.assertNotIn("ghp_", sanitized)
        self.assertNotIn("github_pat_", sanitized)
        self.assertNotIn("hunter2", sanitized)
        self.assertGreaterEqual(sanitized.count("[REDACTED]"), 3)

    def test_gh_adapter_uses_argv_and_json_stdin_for_create(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30, check=True):
            calls.append((list(argv), input_text, timeout, check))
            return type("Result", (), {"returncode": 0, "stdout": "{}", "stderr": ""})()

        client = GitHubCodespacesClient(runner=runner, call_timeout=17)
        client.create_codespace(
            REPOSITORY,
            "feature/quote'$(noop)",
            marker_for(REPOSITORY, BINDING),
            ".devcontainer/agor-managed/devcontainer.json",
            30,
            1440,
        )

        argv, body, timeout, check = calls[0]
        self.assertEqual(argv[0:3], ["gh", "api", "--method"])
        self.assertNotIn("feature/quote", " ".join(argv))
        self.assertEqual(json.loads(body)["ref"], "feature/quote'$(noop)")
        self.assertEqual(timeout, 17)
        self.assertTrue(check)

    def test_gh_adapter_exhausts_paginated_codespace_inventory(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30, check=True):
            calls.append(list(argv))
            output = json.dumps(
                [
                    {"codespaces": [resource(name="octocat-agor-one111")]},
                    {"codespaces": [resource(name="octocat-agor-two222")]},
                ]
            )
            return type(
                "Result", (), {"returncode": 0, "stdout": output, "stderr": ""}
            )()

        client = GitHubCodespacesClient(runner=runner)
        inventory = client.list_codespaces(REPOSITORY)

        self.assertEqual(len(inventory), 2)
        self.assertIn("--paginate", calls[0])
        self.assertIn("--slurp", calls[0])


if __name__ == "__main__":
    unittest.main()
