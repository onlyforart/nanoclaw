/**
 * Build-time validation of Vue templates in app.js.
 *
 * Evaluates the source file in a sandboxed context that stubs out Vue,
 * captures every template string as the JS engine actually interprets it
 * (with escape sequences resolved), then compiles each template with
 * @vue/compiler-dom and fails the build on errors.
 *
 * Usage: node webui/scripts/validate-templates.mjs [path/to/app.js]
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { compile } from '@vue/compiler-dom';

const file = process.argv[2] || path.join(process.cwd(), 'webui', 'public', 'app.js');
const src = fs.readFileSync(file, 'utf8');

// Collect templates by evaluating the JS with a stubbed Vue global.
// Component definitions call app.component(name, { template: `...`, ... })
// so we intercept those calls.
const templates = [];
const noop = () => {};
const reactiveStub = (obj) => obj || {};

const stubVue = {
  createApp: () => {
    const app = {
      component: (name, def) => {
        if (def && typeof def.template === 'string') {
          templates.push({ name, src: def.template });
        }
        return app;
      },
      mount: noop,
    };
    return app;
  },
  ref: (v) => ({ value: v }),
  reactive: reactiveStub,
  computed: noop,
  watch: noop,
  onMounted: noop,
  onUnmounted: noop,
  nextTick: noop,
};

const context = vm.createContext({
  Vue: stubVue,
  window: { location: { hash: '' }, addEventListener: noop },
  document: { documentElement: { classList: { contains: () => false } } },
  localStorage: { getItem: noop, setItem: noop },
  setInterval: noop,
  clearInterval: noop,
  setTimeout: noop,
  console,
});

try {
  vm.runInContext(src, context, { filename: file });
} catch (e) {
  console.error(`Failed to evaluate ${file}: ${e.message}`);
  process.exit(1);
}

if (templates.length === 0) {
  console.error('FAIL: no templates captured from', file);
  process.exit(1);
}

let errors = 0;

for (const t of templates) {
  compile(t.src, {
    mode: 'module',
    onError(err) {
      errors++;
      console.error(`<${t.name}> template error: ${err.message}`);
      if (err.loc) {
        const lines = t.src.split('\n');
        const errLine = err.loc.start.line;
        const errCol = err.loc.start.column;
        if (errLine <= lines.length) {
          console.error(`  ${errLine} | ${lines[errLine - 1]}`);
          console.error(`  ${' '.repeat(String(errLine).length)} | ${' '.repeat(errCol)}^`);
        }
      }
    },
  });
}

if (errors > 0) {
  console.error(`\n${errors} template error(s) found.`);
  process.exit(1);
} else {
  console.log(`OK: ${templates.length} templates compiled successfully.`);
}
