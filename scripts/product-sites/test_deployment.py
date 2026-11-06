import ast
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


def evaluate_condition(condition, event_name, ref):
    if condition is None:
        return True
    expression = condition.removeprefix('${{').removesuffix('}}').strip()
    expression = expression.replace('github.event_name', repr(event_name))
    expression = expression.replace('github.ref', repr(ref))
    expression = expression.replace('&&', ' and ').replace('||', ' or ')
    tree = ast.parse(expression, mode='eval')
    allowed = (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare,
               ast.Eq, ast.NotEq, ast.Constant)
    if any(not isinstance(node, allowed) for node in ast.walk(tree)):
        raise ValueError(f'Unsupported workflow condition: {condition}')
    return bool(eval(compile(tree, '<workflow condition>', 'eval'), {'__builtins__': {}}))


class WorkflowAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ['bun', '-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
             str(root / '.github/workflows/site.yml')],
            check=True, capture_output=True, text=True,
        )
        cls.workflow = json.loads(result.stdout)
        cls.publications = [
            (job_id, job, step)
            for job_id, job in cls.workflow['jobs'].items()
            for step in job['steps']
            if re.search(r'\bwrangler(?:@\S+)?\s+deploy\b', step.get('run', ''))
        ]

    def test_actual_publication_conditions_admit_only_main_push_and_dispatch(self):
        self.assertEqual(len(self.publications), 1)
        cases = (
            ('pull_request', 'refs/pull/123/merge', False),
            ('pull_request', 'refs/heads/main', False),
            ('pull_request_target', 'refs/heads/main', False),
            ('workflow_dispatch', 'refs/heads/feature', False),
            ('push', 'refs/heads/feature', False),
            ('push', 'refs/tags/main', False),
            ('push', 'refs/heads/main', True),
            ('workflow_dispatch', 'refs/heads/main', True),
        )
        for event_name, ref, expected in cases:
            with self.subTest(event_name=event_name, ref=ref):
                self.assertEqual(self.publication_admitted(event_name, ref), expected)

    def publication_admitted(self, event_name, ref):
        _, job, step = self.publications[0]
        return evaluate_condition(job.get('if'), event_name, ref) and evaluate_condition(
            step.get('if'), event_name, ref,
        )

    def test_publication_waits_for_validation_artifact(self):
        self.assertEqual(len(self.publications), 1)
        job_id, job, _ = self.publications[0]
        self.assertNotEqual(job_id, 'build')
        self.assertEqual(job['needs'], 'build')
        uploads = self.artifacts(self.workflow['jobs']['build'], 'upload-artifact')
        downloads = self.artifacts(job, 'download-artifact')
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(downloads), 1)
        self.assertEqual(uploads[0]['with']['path'], 'dist')
        self.assertTrue(uploads[0]['with']['include-hidden-files'])
        self.assertEqual(downloads[0]['with']['path'], 'dist')
        self.assertEqual(uploads[0]['with']['name'], downloads[0]['with']['name'])

    def artifacts(self, job, action):
        return [step for step in job['steps'] if step.get('uses', '').startswith(f'actions/{action}@')]

    def test_validation_stays_credential_free_and_active_on_prs(self):
        self.assertIn('pull_request', self.workflow['on'])
        self.assertEqual(self.workflow['on']['push']['branches'], ['main'])
        self.assertIn('workflow_dispatch', self.workflow['on'])
        build = self.workflow['jobs']['build']
        self.assertNotIn('if', build)
        source = json.dumps(build)
        self.assertNotIn('CLOUDFLARE_', source)
        self.assertNotIn('secrets.', source)
        self.assertNotIn('wrangler', source)
        self.assertIn("python3 -m unittest discover -s scripts/product-sites -p 'test_*.py'", source)
        self.assertIn('bash scripts/product-sites/build.sh dist', source)
        self.assertIn('test -f dist/index.html', source)
        self.assertIn('test -f dist/demo/index.html', source)
        self.assertIn('test -f dist/_headers', source)

    def test_publication_variables_exist_only_on_deploy_step(self):
        self.assertNotIn('env', self.workflow)
        for job in self.workflow['jobs'].values():
            self.assertNotIn('env', job)
        _, _, deploy = self.publications[0]
        self.assertEqual(deploy['env'], {
            'CLOUDFLARE_ACCOUNT_ID': '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
            'CLOUDFLARE_API_TOKEN': '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        })
        other_steps = [
            step for job in self.workflow['jobs'].values() for step in job['steps']
            if step is not deploy
        ]
        self.assertNotIn('CLOUDFLARE_', json.dumps(other_steps))
        self.assertNotIn('secrets.', json.dumps(other_steps))

    def test_publication_uses_one_noncanceling_destination_lock(self):
        self.assertNotIn('concurrency', self.workflow)
        _, job, _ = self.publications[0]
        self.assertEqual(job['concurrency'], {
            'group': 'product-sites-singapore',
            'cancel-in-progress': False,
        })


class DeploymentTests(unittest.TestCase):
    def test_cloudflare_config_uses_exact_domain_and_root_assets(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / 'wrangler.singapore.jsonc').read_text()
        config = json.loads(re.sub(r',\s*([}\]])', r'\1', source))
        self.assertEqual(
            config['routes'],
            [{'pattern': 'singapore.shaulavo.dev', 'custom_domain': True}],
        )
        self.assertFalse(config['workers_dev'])
        self.assertFalse(config['preview_urls'])
        self.assertEqual(config['assets'], {
            'directory': './dist',
            'html_handling': 'auto-trailing-slash',
            'not_found_handling': 'none',
        })
        self.assertFalse((root / '.github/workflows/product-sites.yml').exists())

    def test_build_keeps_docs_and_demo_at_separate_routes(self):
        with tempfile.TemporaryDirectory(prefix='singapore-site-build-') as directory:
            root = Path(directory)
            scripts = root / 'scripts/product-sites'
            scripts.mkdir(parents=True)
            source_root = Path(__file__).resolve().parents[2]
            (scripts / 'build.sh').write_text((source_root / 'scripts/product-sites/build.sh').read_text())
            (scripts / '_headers').write_text((source_root / 'scripts/product-sites/_headers').read_text())
            for folder in ('site', 'examples/app'):
                (root / folder / 'dist').mkdir(parents=True)
                (root / folder / 'dist/index.html').write_text(folder)

            binary = root / 'bin'
            binary.mkdir()
            bun = binary / 'bun'
            bun.write_text(
                '#!/bin/sh\nprintf "%s %s %s %s\\n" "$SITE_ORIGIN" "$VITE_BASE_PATH" "$*" "$PWD" >> "$BUILD_LOG"\n'
            )
            bun.chmod(0o755)
            log = root / 'build.log'
            env = {
                **os.environ,
                'PATH': f'{binary}{os.pathsep}{os.environ["PATH"]}',
                'BUILD_LOG': str(log),
            }
            output = root / 'output'
            subprocess.run(['bash', str(scripts / 'build.sh'), str(output)], env=env, check=True)

            commands = log.read_text()
            self.assertIn('https://singapore.shaulavo.dev  run --cwd site build --base /', commands)
            self.assertIn(' /demo/ run --cwd examples/app build', commands)
            self.assertIn('run build -- --filter=singapore-editor-site --filter=@singapore-editor/example-app', commands)
            self.assertEqual((output / 'index.html').read_text(), 'site')
            self.assertEqual((output / 'demo/index.html').read_text(), 'examples/app')
            self.assertEqual((output / '_headers').read_text(), (source_root / 'scripts/product-sites/_headers').read_text())

    def test_only_hashed_assets_have_immutable_cache_headers(self):
        source = (Path(__file__).resolve().parent / '_headers').read_text()
        rules = {}
        path = None
        for line in source.splitlines():
            if not line.strip():
                continue
            if not line.startswith(' '):
                path = line
                rules[path] = {}
                continue
            name, value = line.strip().split(':', 1)
            rules[path][name.lower()] = value.strip()

        immutable = {
            path: headers['cache-control']
            for path, headers in rules.items()
            if 'cache-control' in headers
        }
        self.assertEqual(immutable, {
            '/_astro/*': 'public, max-age=31536000, immutable',
            '/demo/assets/*': 'public, max-age=31536000, immutable',
        })
        self.assertNotIn('cache-control', rules['/*'])


if __name__ == '__main__':
    unittest.main()
