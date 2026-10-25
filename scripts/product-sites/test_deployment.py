import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


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
