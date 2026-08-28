#!/usr/bin/env python3
"""Experimental GitHub Codespaces lifecycle bridge for Agor.

The bridge deliberately delegates authentication to the official ``gh`` CLI.
It never reads or prints a token. Every action rediscovers the authenticated
user's Codespaces and validates owner, repository, ref, and an Agor branch
marker before it acts on a remote resource.

This file is standard-library-only so it can later become the core of a small
``agor-codespaces`` package without making a repository variant install an
unreviewed dependency at Play time.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol, Sequence

API_VERSION = "2026-03-10"
RESULT_PREFIX = "AGOR_ENVIRONMENT_RESULT="
FAILURE_STATES = {"Failed", "Unavailable"}
TOKEN_PATTERN = re.compile(
    r"(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|"
    r"sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})"
)
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
BINDING_PATTERN = re.compile(r"^[0-9a-fA-F-]{16,64}$")


class LauncherError(RuntimeError):
    """A user-safe lifecycle failure."""


def redact(value: str) -> str:
    """Best-effort log/error redaction; tokens never belong in bridge output."""

    redacted = TOKEN_PATTERN.sub("[REDACTED]", value)
    redacted = re.sub(
        r"(?i)(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+",
        r"\1[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?i)([?&](?:access_token|auth|key|secret|token)=)[^&#\s]+",
        r"\1[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?i)(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*)[^\s]+",
        r"\1[REDACTED]",
        redacted,
    )
    return redacted


@dataclasses.dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class Runner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        input_text: str | None = None,
        timeout: float = 30,
        check: bool = True,
    ) -> CommandResult: ...


def run_command(
    argv: Sequence[str],
    *,
    input_text: str | None = None,
    timeout: float = 30,
    check: bool = True,
) -> CommandResult:
    env = dict(os.environ)
    env["GH_PROMPT_DISABLED"] = "1"
    env["NO_COLOR"] = "1"
    try:
        completed = subprocess.run(
            list(argv),
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except FileNotFoundError as exc:
        raise LauncherError("GitHub CLI (`gh`) is required but was not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise LauncherError(f"provider command timed out after {timeout:g}s") from exc

    result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
    if check and result.returncode != 0:
        detail = redact((result.stderr or result.stdout).strip())
        if len(detail) > 2_000:
            detail = f"...{detail[-2_000:]}"
        raise LauncherError(
            f"GitHub CLI command failed with exit code {result.returncode}"
            + (f": {detail}" if detail else "")
        )
    return result


class GitHubCodespacesClient:
    """Narrow adapter over documented REST endpoints and official gh tunnels."""

    def __init__(self, runner: Runner = run_command, call_timeout: float = 30) -> None:
        self._run = runner
        self._call_timeout = call_timeout

    def _api(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        body: Mapping[str, Any] | None = None,
    ) -> Any:
        argv = [
            "gh",
            "api",
            "--method",
            method,
            "-H",
            f"X-GitHub-Api-Version:{API_VERSION}",
            endpoint,
        ]
        input_text = None
        if body is not None:
            argv.extend(["--input", "-"])
            input_text = json.dumps(body, separators=(",", ":"))
        result = self._run(
            argv,
            input_text=input_text,
            timeout=self._call_timeout,
            check=True,
        )
        if not result.stdout.strip():
            return None
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise LauncherError("GitHub API returned invalid JSON") from exc

    def viewer(self) -> str:
        response = self._api("user")
        login = response.get("login") if isinstance(response, dict) else None
        if not isinstance(login, str) or not login:
            raise LauncherError("GitHub API did not return the authenticated actor")
        return login

    def repository(self, repository: str) -> Mapping[str, Any]:
        response = self._api(f"repos/{repository}")
        if not isinstance(response, dict):
            raise LauncherError("GitHub API did not return the repository")
        return response

    def resolve_ref(self, repository: str, ref: str) -> str:
        encoded_ref = urllib.parse.quote(ref, safe="")
        response = self._api(f"repos/{repository}/commits/{encoded_ref}")
        sha = response.get("sha") if isinstance(response, dict) else None
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
            raise LauncherError(f"GitHub did not resolve ref {ref!r} to a commit")
        return sha.lower()

    def list_codespaces(self, repository: str) -> list[Mapping[str, Any]]:
        owner, repo = repository.split("/", 1)
        result = self._run(
            [
                "gh",
                "api",
                "--method",
                "GET",
                "-H",
                f"X-GitHub-Api-Version:{API_VERSION}",
                "--paginate",
                "--slurp",
                f"repos/{owner}/{repo}/codespaces?per_page=100",
            ],
            timeout=self._call_timeout,
            check=True,
        )
        try:
            pages = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise LauncherError(
                "GitHub API returned invalid Codespaces list JSON"
            ) from exc
        if not isinstance(pages, list):
            raise LauncherError("GitHub API did not return Codespaces list pages")
        codespaces: list[Mapping[str, Any]] = []
        for page in pages:
            page_items = page.get("codespaces") if isinstance(page, dict) else None
            if not isinstance(page_items, list):
                raise LauncherError(
                    "GitHub API returned an invalid Codespaces list page"
                )
            codespaces.extend(item for item in page_items if isinstance(item, dict))
        return codespaces

    def create_codespace(
        self,
        repository: str,
        ref: str,
        display_name: str,
        devcontainer_path: str,
        idle_timeout_minutes: int,
        retention_period_minutes: int,
    ) -> Mapping[str, Any]:
        owner, repo = repository.split("/", 1)
        response = self._api(
            f"repos/{owner}/{repo}/codespaces",
            method="POST",
            body={
                "ref": ref,
                "display_name": display_name,
                "devcontainer_path": devcontainer_path,
                "idle_timeout_minutes": idle_timeout_minutes,
                "retention_period_minutes": retention_period_minutes,
            },
        )
        if not isinstance(response, dict):
            raise LauncherError("GitHub API did not return the created Codespace")
        return response

    def get_codespace(self, name: str) -> Mapping[str, Any]:
        response = self._api(f"user/codespaces/{name}")
        if not isinstance(response, dict):
            raise LauncherError("GitHub API did not return the Codespace")
        return response

    def start_codespace(self, name: str) -> None:
        self._api(f"user/codespaces/{name}/start", method="POST")

    def stop_codespace(self, name: str) -> None:
        self._api(f"user/codespaces/{name}/stop", method="POST")

    def delete_codespace(self, name: str) -> None:
        self._api(f"user/codespaces/{name}", method="DELETE")

    def list_ports(self, name: str) -> list[Mapping[str, Any]]:
        # `gh codespace ports` connects to the Codespaces dev-tunnel service;
        # the public REST Codespaces response has no forwarded-port inventory.
        # This is intentionally NOT `ports forward`, so it opens no local port.
        result = self._run(
            [
                "gh",
                "codespace",
                "ports",
                "-c",
                name,
                "--json",
                "sourcePort,visibility,label,browseUrl",
            ],
            timeout=self._call_timeout,
            check=True,
        )
        try:
            ports = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise LauncherError("GitHub CLI returned invalid port JSON") from exc
        if not isinstance(ports, list):
            raise LauncherError("GitHub CLI did not return a port list")
        return [item for item in ports if isinstance(item, dict)]

    def remote_health(self, name: str, health_port: int) -> bool:
        # The command is fixed except for a validated integer and never invokes
        # a remote shell with repository/ref/user-controlled text.
        command = (
            f"curl -fsS --max-time 5 http://127.0.0.1:{health_port}/health >/dev/null"
        )
        result = self._run(
            ["gh", "codespace", "ssh", "-c", name, "--", command],
            timeout=self._call_timeout,
            check=False,
        )
        return result.returncode == 0

    def creation_logs(self, name: str) -> str:
        result = self._run(
            ["gh", "codespace", "logs", "-c", name],
            timeout=max(self._call_timeout, 60),
            check=True,
        )
        return redact(result.stdout)

    def runtime_logs(self, name: str, repository: str) -> str:
        repo_name = repository.split("/", 1)[1]
        workspace = shlex.quote(f"/workspaces/{repo_name}")
        command = f"cd {workspace} && docker compose -p agor-codespaces-sqlite logs --tail=150"
        result = self._run(
            ["gh", "codespace", "ssh", "-c", name, "--", command],
            timeout=max(self._call_timeout, 60),
            check=True,
        )
        return redact(result.stdout)


def normalize_ref(ref: str) -> str:
    for prefix in ("refs/heads/", "refs/tags/"):
        if ref.startswith(prefix):
            return ref[len(prefix) :]
    return ref


def marker_for(repository: str, binding: str) -> str:
    digest = hashlib.sha256(
        f"{repository.lower()}\0{binding.lower()}".encode()
    ).hexdigest()
    return f"agor-cs-{digest[:28]}"


def resource_name(resource: Mapping[str, Any]) -> str:
    name = resource.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9-]{3,128}", name):
        raise LauncherError("Codespace has an invalid resource name")
    return name


def validate_resource(
    resource: Mapping[str, Any],
    *,
    owner: str,
    repository: str,
    repository_id: int,
    ref: str,
    marker: str,
) -> None:
    actual_owner = (resource.get("owner") or {}).get("login")
    actual_repository = (resource.get("repository") or {}).get("full_name")
    actual_repository_id = (resource.get("repository") or {}).get("id")
    git_status = resource.get("git_status") or {}
    actual_ref = normalize_ref(str(git_status.get("ref") or ""))
    actual_marker = resource.get("display_name")
    mismatches = []
    if str(actual_owner).lower() != owner.lower():
        mismatches.append("owner")
    if str(actual_repository).lower() != repository.lower():
        mismatches.append("repository")
    if actual_repository_id != repository_id:
        mismatches.append("repository ID")
    if actual_ref != normalize_ref(ref):
        mismatches.append("ref")
    if actual_marker != marker:
        mismatches.append("binding marker")
    if mismatches:
        raise LauncherError(
            f"refusing Codespace {resource_name(resource)!r}: mismatched "
            + ", ".join(mismatches)
        )


class StateStore:
    """Local non-secret ownership fence; discovery never trusts it as lookup truth."""

    def __init__(self, directory: Path, repository: str, binding: str) -> None:
        digest = hashlib.sha256(
            f"{repository.lower()}\0{binding.lower()}".encode()
        ).hexdigest()
        self.directory = directory
        self.path = directory / f"{digest}.json"
        self.lock_path = directory / f"{digest}.lock"

    def _ensure_directory(self) -> None:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with contextlib.suppress(PermissionError):
            self.directory.chmod(0o700)

    @contextlib.contextmanager
    def lock(self) -> Iterator[None]:
        self._ensure_directory()
        descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def load(self) -> Mapping[str, Any] | None:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LauncherError(
                f"invalid local Codespace binding state: {self.path}"
            ) from exc
        if not isinstance(value, dict):
            raise LauncherError(f"invalid local Codespace binding state: {self.path}")
        return value

    def save(self, value: Mapping[str, Any]) -> None:
        self._ensure_directory()
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", dir=self.directory
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(value, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)

    def clear(self) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()


@dataclasses.dataclass(frozen=True)
class Discovery:
    owner: str
    repository_id: int
    resource: Mapping[str, Any] | None


class CodespaceController:
    def __init__(
        self,
        *,
        client: GitHubCodespacesClient,
        store: StateStore,
        repository: str,
        ref: str,
        binding: str,
        devcontainer_path: str,
        idle_timeout_minutes: int,
        retention_period_minutes: int,
        app_port: int,
        health_port: int,
        wait_seconds: int,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.store = store
        self.repository = repository
        self.ref = normalize_ref(ref)
        self.binding = binding
        self.marker = marker_for(repository, binding)
        self.devcontainer_path = devcontainer_path
        self.idle_timeout_minutes = idle_timeout_minutes
        self.retention_period_minutes = retention_period_minutes
        self.app_port = app_port
        self.health_port = health_port
        self.wait_seconds = wait_seconds
        self.sleep = sleep
        self.monotonic = monotonic

    def discover(self) -> Discovery:
        owner = self.client.viewer()
        repository = self.client.repository(self.repository)
        repository_id = repository.get("id")
        if str(
            repository.get("full_name", "")
        ).lower() != self.repository.lower() or not isinstance(repository_id, int):
            raise LauncherError(
                "GitHub repository identity did not match the requested repository"
            )
        resources = self.client.list_codespaces(self.repository)
        state = self.store.load()
        if state is not None:
            expected = {
                "binding": self.binding,
                "repository": self.repository,
                "ref": self.ref,
            }
            if any(state.get(key) != value for key, value in expected.items()):
                raise LauncherError(
                    "local Codespace binding state belongs to another branch"
                )
            if str(state.get("owner", "")).lower() != owner.lower():
                raise LauncherError(
                    "this environment is bound to another GitHub actor; use the original actor to manage or nuke it"
                )
            if state.get("repository_id") not in (None, repository_id):
                raise LauncherError(
                    "local Codespace binding state belongs to another repository ID"
                )

        matches = [
            item for item in resources if item.get("display_name") == self.marker
        ]
        if len(matches) > 1:
            names = ", ".join(sorted(resource_name(item) for item in matches))
            raise LauncherError(
                f"ambiguous Codespace binding; refusing to choose among: {names}"
            )

        if not matches:
            stored_name = state.get("name") if state else None
            if stored_name and any(
                item.get("name") == stored_name for item in resources
            ):
                raise LauncherError(
                    "stored Codespace still exists but no longer has the expected marker"
                )
            return Discovery(owner, repository_id, None)

        resource = matches[0]
        validate_resource(
            resource,
            owner=owner,
            repository=self.repository,
            repository_id=repository_id,
            ref=self.ref,
            marker=self.marker,
        )
        return Discovery(owner, repository_id, resource)

    def _save_binding(
        self,
        owner: str,
        resource: Mapping[str, Any],
        *,
        resolved_sha: str | None = None,
    ) -> None:
        previous = self.store.load() or {}
        self.store.save(
            {
                "version": 1,
                "binding": self.binding,
                "repository": self.repository,
                "repository_id": (resource.get("repository") or {}).get("id"),
                "ref": self.ref,
                "owner": owner,
                "name": resource_name(resource),
                "display_name": self.marker,
                "created_ref_sha": resolved_sha or previous.get("created_ref_sha"),
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )

    def _refetch_and_validate(
        self, owner: str, repository_id: int, resource: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        current = self.client.get_codespace(resource_name(resource))
        validate_resource(
            current,
            owner=owner,
            repository=self.repository,
            repository_id=repository_id,
            ref=self.ref,
            marker=self.marker,
        )
        return current

    def _wait_for_state(
        self, owner: str, repository_id: int, name: str, desired: str
    ) -> Mapping[str, Any]:
        deadline = self.monotonic() + self.wait_seconds
        while True:
            resource = self.client.get_codespace(name)
            validate_resource(
                resource,
                owner=owner,
                repository=self.repository,
                repository_id=repository_id,
                ref=self.ref,
                marker=self.marker,
            )
            state = str(resource.get("state") or "")
            if state == desired:
                return resource
            if state in FAILURE_STATES:
                raise LauncherError(f"Codespace entered terminal state {state}")
            if self.monotonic() >= deadline:
                raise LauncherError(
                    f"timed out after {self.wait_seconds}s waiting for Codespace state {desired} (last: {state or 'unknown'})"
                )
            self.sleep(3)

    def _wait_for_preview(self, name: str) -> list[Mapping[str, Any]]:
        deadline = self.monotonic() + self.wait_seconds
        last_error = "preview not ready"
        expected_ports = {self.app_port, self.health_port}
        while True:
            try:
                ports = self.client.list_ports(name)
                actual_ports = {
                    int(item["sourcePort"])
                    for item in ports
                    if isinstance(item.get("sourcePort"), int)
                }
                missing = sorted(expected_ports - actual_ports)
                if missing:
                    last_error = f"forwarded ports not registered: {missing}"
                elif self.client.remote_health(name, self.health_port):
                    return ports
                else:
                    last_error = "remote Agor /health is not ready"
            except LauncherError as exc:
                last_error = str(exc)

            if self.monotonic() >= deadline:
                raise LauncherError(
                    f"timed out after {self.wait_seconds}s waiting for the Codespace preview: {last_error}"
                )
            self.sleep(3)

    def start(self) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
        discovery = self.discover()
        resource = discovery.resource
        resolved_sha: str | None = None
        if resource is None:
            resolved_sha = self.client.resolve_ref(self.repository, self.ref)
            resource = self.client.create_codespace(
                self.repository,
                self.ref,
                self.marker,
                self.devcontainer_path,
                self.idle_timeout_minutes,
                self.retention_period_minutes,
            )
            validate_resource(
                resource,
                owner=discovery.owner,
                repository=self.repository,
                repository_id=discovery.repository_id,
                ref=self.ref,
                marker=self.marker,
            )

        name = resource_name(resource)
        state = str(resource.get("state") or "")
        if state == "Shutdown":
            resource = self._refetch_and_validate(
                discovery.owner, discovery.repository_id, resource
            )
            name = resource_name(resource)
            state = str(resource.get("state") or "")
            if state == "Shutdown":
                self.client.start_codespace(name)
        if state in FAILURE_STATES:
            raise LauncherError(
                f"Codespace is in terminal state {state}; nuke it before retrying"
            )

        resource = self._wait_for_state(
            discovery.owner, discovery.repository_id, name, "Available"
        )
        ports = self._wait_for_preview(name)
        self._save_binding(discovery.owner, resource, resolved_sha=resolved_sha)
        return resource, ports

    def stop(self) -> Mapping[str, Any] | None:
        discovery = self.discover()
        if discovery.resource is None:
            self.store.clear()
            return None
        resource = self._refetch_and_validate(
            discovery.owner, discovery.repository_id, discovery.resource
        )
        name = resource_name(resource)
        if resource.get("state") != "Shutdown":
            self.client.stop_codespace(name)
        resource = self._wait_for_state(
            discovery.owner, discovery.repository_id, name, "Shutdown"
        )
        self._save_binding(discovery.owner, resource)
        return resource

    def nuke(self) -> bool:
        discovery = self.discover()
        if discovery.resource is None:
            self.store.clear()
            return False
        resource = self._refetch_and_validate(
            discovery.owner, discovery.repository_id, discovery.resource
        )
        self.client.delete_codespace(resource_name(resource))
        deadline = self.monotonic() + self.wait_seconds
        while True:
            current = self.discover()
            if current.resource is None:
                self.store.clear()
                return True
            if self.monotonic() >= deadline:
                raise LauncherError(
                    f"timed out after {self.wait_seconds}s waiting for Codespace deletion"
                )
            self.sleep(3)

    def health(self) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
        discovery = self.discover()
        if discovery.resource is None:
            raise LauncherError("no Codespace is bound to this branch")
        resource = discovery.resource
        if resource.get("state") != "Available":
            raise LauncherError(
                f"Codespace is not available (state: {resource.get('state')})"
            )
        ports = self.client.list_ports(resource_name(resource))
        if not self.client.remote_health(resource_name(resource), self.health_port):
            raise LauncherError("remote Agor /health is unhealthy")
        return resource, ports

    def logs(self) -> str:
        discovery = self.discover()
        if discovery.resource is None:
            return "No Codespace is bound to this branch.\n"
        resource = discovery.resource
        summary = json.dumps(public_summary(resource, []), sort_keys=True)
        name = resource_name(resource)
        if resource.get("state") != "Available":
            return (
                f"{summary}\nCodespace logs were not fetched because GitHub CLI would resume "
                "a stopped Codespace. Press Play before requesting Logs.\n"
            )
        creation_logs = self.client.creation_logs(name)
        runtime_logs = self.client.runtime_logs(name, self.repository)
        return (
            f"{summary}\n--- Codespace creation log ---\n{creation_logs}"
            f"--- Agor runtime log ---\n{runtime_logs}"
        )


def validated_http_url(value: Any, *, codespace_name: str | None = None) -> str | None:
    if not isinstance(value, str) or len(value) > 2_048:
        return None
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return None
    if codespace_name and not (
        parsed.hostname == f"{codespace_name}.github.dev"
        or (
            parsed.hostname.endswith(".app.github.dev")
            and parsed.hostname.startswith(f"{codespace_name}-")
        )
    ):
        return None
    return value


def access_urls(
    resource: Mapping[str, Any], ports: Sequence[Mapping[str, Any]], app_port: int
) -> list[dict[str, str]]:
    name = resource_name(resource)
    app = next(
        (
            validated_http_url(item.get("browseUrl"), codespace_name=name)
            for item in ports
            if item.get("sourcePort") == app_port
        ),
        None,
    )
    editor = validated_http_url(resource.get("web_url"), codespace_name=name)
    if not app:
        raise LauncherError(
            f"GitHub did not report a safe browse URL for port {app_port}"
        )
    urls = [{"name": "App", "url": app}]
    if editor:
        urls.append({"name": "Codespace", "url": editor})
    return urls


def public_summary(
    resource: Mapping[str, Any], ports: Sequence[Mapping[str, Any]]
) -> Mapping[str, Any]:
    return {
        "codespace": {
            "name": resource.get("name"),
            "display_name": resource.get("display_name"),
            "owner": (resource.get("owner") or {}).get("login"),
            "repository": (resource.get("repository") or {}).get("full_name"),
            "ref": (resource.get("git_status") or {}).get("ref"),
            "state": resource.get("state"),
            "web_url": resource.get("web_url"),
        },
        "ports": [
            {
                "sourcePort": item.get("sourcePort"),
                "visibility": item.get("visibility"),
                "label": item.get("label"),
                "browseUrl": item.get("browseUrl"),
            }
            for item in ports
        ],
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "nuke", "health", "logs"))
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--binding", required=True)
    parser.add_argument(
        "--devcontainer-path",
        default=".devcontainer/agor-managed/devcontainer.json",
    )
    parser.add_argument("--idle-timeout-minutes", type=int, default=30)
    parser.add_argument("--retention-period-minutes", type=int, default=1440)
    parser.add_argument("--app-port", type=int, default=5000)
    parser.add_argument("--health-port", type=int, default=3000)
    parser.add_argument("--wait-seconds", type=int, default=600)
    parser.add_argument("--provider-call-timeout", type=int, default=30)
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(
            os.environ.get(
                "AGOR_CODESPACES_STATE_DIR",
                Path.home() / ".local" / "state" / "agor" / "codespaces",
            )
        ),
    )
    args = parser.parse_args(argv)

    if not REPOSITORY_PATTERN.fullmatch(args.repository):
        parser.error("--repository must be an owner/repository slug")
    if not BINDING_PATTERN.fullmatch(args.binding):
        parser.error("--binding must be a stable UUID-like identifier")
    if not args.ref or "\0" in args.ref or len(args.ref) > 255:
        parser.error("--ref must be a non-empty git ref no longer than 255 characters")
    if not re.fullmatch(
        r"\.devcontainer/[A-Za-z0-9_.-]+/devcontainer\.json", args.devcontainer_path
    ):
        parser.error("--devcontainer-path must name one .devcontainer subdirectory")
    if not 5 <= args.idle_timeout_minutes <= 240:
        parser.error("--idle-timeout-minutes must be between 5 and 240")
    if not 0 <= args.retention_period_minutes <= 43_200:
        parser.error("--retention-period-minutes must be between 0 and 43200")
    for field in ("app_port", "health_port"):
        if not 1 <= getattr(args, field) <= 65_535:
            parser.error(f"--{field.replace('_', '-')} must be a valid TCP port")
    if not 30 <= args.wait_seconds <= 1_800:
        parser.error("--wait-seconds must be between 30 and 1800")
    if not 5 <= args.provider_call_timeout <= 120:
        parser.error("--provider-call-timeout must be between 5 and 120")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    store = StateStore(args.state_dir, args.repository, args.binding)
    client = GitHubCodespacesClient(call_timeout=args.provider_call_timeout)
    controller = CodespaceController(
        client=client,
        store=store,
        repository=args.repository,
        ref=args.ref,
        binding=args.binding,
        devcontainer_path=args.devcontainer_path,
        idle_timeout_minutes=args.idle_timeout_minutes,
        retention_period_minutes=args.retention_period_minutes,
        app_port=args.app_port,
        health_port=args.health_port,
        wait_seconds=args.wait_seconds,
    )

    try:
        with store.lock():
            if args.action == "start":
                resource, ports = controller.start()
                print(json.dumps(public_summary(resource, ports), sort_keys=True))
                print(
                    RESULT_PREFIX
                    + json.dumps(
                        {"access_urls": access_urls(resource, ports, args.app_port)},
                        separators=(",", ":"),
                    )
                )
            elif args.action == "stop":
                resource = controller.stop()
                print(
                    "Codespace already absent"
                    if resource is None
                    else "Codespace stopped"
                )
            elif args.action == "nuke":
                print(
                    "Codespace deleted"
                    if controller.nuke()
                    else "Codespace already absent"
                )
            elif args.action == "health":
                resource, ports = controller.health()
                print(json.dumps(public_summary(resource, ports), sort_keys=True))
            else:
                print(controller.logs(), end="")
        return 0
    except LauncherError as exc:
        print(f"agor-codespaces: {redact(str(exc))}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
