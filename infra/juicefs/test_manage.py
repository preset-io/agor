import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import manage


class StorageBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.c = {'name': 'agor-juicefs', 'tenant': 'default',
                  'metadata_url': 'postgres://juicefs@localhost/juicefs',
                  'bucket': 'https://test.s3.ap-southeast-2.amazonaws.com',
                  'mount': str(root/'mount'), 'home': str(root/'home'),
                  'cache': str(root/'cache'), 'password_file': str(root/'password'),
                  'image': 'agor-juicefs:local'}
        self.file = root/'config.json'

    def load(self):
        self.file.write_text(json.dumps(self.c))
        return manage.config(self.file)

    def test_rejects_other_tenant_and_overlapping_private_home(self):
        self.c['tenant'] = 'other-tenant'
        with self.assertRaises(ValueError): self.load()
        self.c['tenant'] = 'default'
        self.c['home'] = self.c['mount']+'/home'
        with self.assertRaises(ValueError): self.load()

    def test_writeback_is_explicit_and_has_no_extra_upload_delay(self):
        self.assertNotIn('--writeback', manage.mount_command(self.load()))
        self.c['writeback'] = True
        command = manage.mount_command(self.load())
        self.assertIn('--writeback', command)
        self.assertEqual(command[command.index('--upload-delay')+1], '0')
        self.c['writeback'] = 'false'
        with self.assertRaises(ValueError): self.load()

    def test_private_https_backend_configuration(self):
        self.c.update(bind_address='10.87.2.164', public_origin='https://juicefs.skellige.com.au')
        args = manage.docker_command(self.load())
        self.assertIn('10.87.2.164:3031:3030', args)
        self.assertIn('CORS_ORIGIN=https://juicefs.skellige.com.au', args)
        self.c['bind_address'] = '0.0.0.0'
        with self.assertRaises(ValueError): self.load()
        self.c['bind_address'] = '127.0.0.1'
        self.c['public_origin'] = 'https://host/path'
        with self.assertRaises(ValueError): self.load()

    def test_password_cannot_enter_argv_or_public_file(self):
        self.c['metadata_url'] = 'postgres://user:secret@localhost/juicefs'
        with self.assertRaises(ValueError): self.load()
        p = Path(self.c['password_file'])
        p.write_text('secret')
        p.chmod(0o644)
        with self.assertRaises(ValueError): manage.environment(self.c)
        p.chmod(0o600)
        self.assertEqual(manage.environment(self.c)['META_PASSWORD_FILE'], str(p))

    def test_refuses_local_disk_fallback(self):
        with patch('manage.subprocess.run') as run:
            run.return_value.stdout = json.dumps({'filesystems': [{'fstype': 'xfs'}]})
            with self.assertRaises(ValueError): manage.verify(self.c)

    def test_refuses_wrong_volume_or_tenant(self):
        root = Path(self.c['mount']); root.mkdir()
        (root/manage.MARKER).write_text(json.dumps({**manage.identity(self.c), 'tenant': 'other'}))
        with patch('manage.mounted'):
            with self.assertRaises(ValueError): manage.verify(self.c)

    def test_accepts_juicefs_virtual_files_but_not_unowned_user_data(self):
        root = Path(self.c['mount']); root.mkdir()
        (root/'.config').write_text('JuiceFS virtual configuration')
        (root/'someone-elses-data').write_text('private')
        with patch('manage.mounted'), patch('manage.os.chown'):
            with self.assertRaises(ValueError): manage.prepare(self.c)
            (root/'someone-elses-data').unlink()
            manage.prepare(self.c)
            manage.verify(self.c)

    def test_initializes_private_state_before_binding_shared_workspaces(self):
        root = Path(self.c['mount']); root.mkdir()
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            if '--entrypoint' in args:
                home = Path(self.c['home'])/'.agor'
                self.assertFalse((home/'repos').exists())
                home.mkdir(exist_ok=True)
                (home/'config.yaml').write_text('test config')
                (home/'agor.db').touch()
        with patch('manage.mounted'), patch('manage.os.chown'), patch('manage.subprocess.run', side_effect=run):
            manage.prepare(self.c)
            manage.start(self.c)
        self.assertEqual(len(commands), 2)
        self.assertIn('init', commands[0])
        self.assertNotIn(str(root), ' '.join(commands[0]))
        self.assertEqual(commands[1], manage.docker_command(self.c))

    def test_container_gets_workspaces_but_no_storage_authority(self):
        args = manage.docker_command(self.c)
        binds = [args[i+1] for i, a in enumerate(args) if a == '--mount']
        self.assertEqual(len(binds), 3)
        self.assertIn('dst=/home/agor/.agor/repos', binds[1])
        self.assertIn('dst=/home/agor/.agor/worktrees', binds[2])
        self.assertNotIn(self.c['password_file'], ' '.join(args))
        self.assertNotIn(self.c['metadata_url'], ' '.join(args))
        self.assertNotIn(self.c['cache'], ' '.join(args))
        self.assertNotIn('--privileged', args)


if __name__ == '__main__':
    unittest.main()
