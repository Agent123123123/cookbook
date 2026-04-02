# Rebuild And Reinstall REH Server On Linux x64

This document records the steps that worked for rebuilding and reinstalling the Code - OSS remote server (`vscode-reh-linux-x64`) from this repository on another Linux machine.

Scope:
- Repository: `microsoft/vscode`
- Branch used during validation: `ai-ide-1.113.0`
- Target artifact: `vscode-reh-linux-x64`
- Target install root: `~/.vscode-server-oss/bin/<commit>`

## 1. Prerequisites

Required tools:

- Node.js `22.22.1`
- npm `10.x`
- Python `3.11+`
- `curl`, `tar`, `rsync`
- Enough memory for the build. The successful run used a larger Node heap (`24 GiB`).

Check the required Node version from the repository root:

```bash
cat .nvmrc
```

At the time this guide was written, it was:

```text
22.22.1
```

## 2. Optional npm Proxy

If the new machine needs a proxy, configure both `proxy` and `https-proxy`.

```bash
npm config set --location=user proxy http://HOST:PORT
npm config set --location=user https-proxy http://HOST:PORT
```

Verify:

```bash
npm config get proxy
npm config get https-proxy
```

## 3. Install Dependencies

Start with the normal path:

```bash
cd /path/to/vscode
npm ci
```

If `npm ci` succeeds, continue to the build step.

### Older Linux Hosts: Known Working Bootstrap

On older Linux systems, `npm ci` may fail because:

- `node-gyp` picks an old Python such as `3.6`
- system `g++` is too old for the native modules
- `pkg-config` cannot find `x11.pc` or `xkbfile.pc`

The following sequence worked on an older RHEL-like host:

```bash
cd /path/to/vscode

# setup-env.sh needs these modules before the full install finishes
npm install --ignore-scripts debug extract-zip @electron/get --no-save

export VSCODE_ARCH=x64
export npm_config_arch=x64

python() { /usr/bin/python3.11 "$@"; }
source ./build/azure-pipelines/linux/setup-env.sh

SYSROOT="$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu/x86_64-linux-gnu/sysroot"
export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
export PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/lib/pkgconfig:$SYSROOT/usr/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"

rm -rf node_modules
PYTHON=/usr/bin/python3.11 npm_config_python=/usr/bin/python3.11 npm ci
```

## 4. Branch-Specific Fix For `ai-ide-1.113.0`

On this branch, one fixture helper used an obsolete `@vscode/component-explorer` option and blocked `tsgo` typecheck.

Symptom:

```text
Object literal may only specify known properties, and 'properties' does not exist in type 'DefineFixtureOptions'
```

Fix:

Remove `properties: []` from:

- [src/vs/workbench/test/browser/componentFixtures/fixtureUtils.ts](../src/vs/workbench/test/browser/componentFixtures/fixtureUtils.ts)

If your checkout already contains that change, no extra action is needed.

## 5. Build The Server Artifact

Use the locally installed tool binaries and invoke the two build steps sequentially.

```bash
cd /path/to/vscode
export PATH="$PWD/node_modules/.bin:$PATH"

node --max-old-space-size=24576 --max-semi-space-size=256 ./node_modules/gulp/bin/gulp.js core-ci
node --max-old-space-size=24576 --max-semi-space-size=256 ./node_modules/gulp/bin/gulp.js vscode-reh-linux-x64-min-ci
```

Expected output artifact:

```text
../vscode-reh-linux-x64
```

Important:

- Do not run `core-ci` and `vscode-reh-linux-x64-min-ci` in one gulp invocation.
- This is wrong:

```bash
node ./node_modules/gulp/bin/gulp.js core-ci vscode-reh-linux-x64-min-ci
```

- Gulp treats those as two top-level tasks and may schedule packaging before `out-vscode-reh-min` exists.
- The result can be an incomplete package that is missing `out/server-main.js`.

## 6. Verify The Artifact

Check the package contents:

```bash
find ../vscode-reh-linux-x64 -maxdepth 1 -mindepth 1 | sort
```

The package should contain at least:

- `bin/`
- `extensions/`
- `node`
- `node_modules/`
- `out/`
- `package.json`
- `product.json`

Check the packaged version:

```bash
../vscode-reh-linux-x64/bin/code-server-oss --version
```

## 7. Install The Server Into The Correct Commit Directory

The install directory must match the `commit` written into the built artifact's `product.json`.

Read the commit:

```bash
python3 - <<'PY'
import json
with open('../vscode-reh-linux-x64/product.json', 'r', encoding='utf-8') as f:
    print(json.load(f)['commit'])
PY
```

Install with `rsync`:

```bash
commit="$(python3 - <<'PY'
import json
with open('../vscode-reh-linux-x64/product.json', 'r', encoding='utf-8') as f:
    print(json.load(f)['commit'])
PY
)"

target="$HOME/.vscode-server-oss/bin/$commit"
mkdir -p "$target"
rsync -a --delete ../vscode-reh-linux-x64/ "$target/"
```

Verify the installed server:

```bash
"$target/bin/code-server-oss" --version
```

The second line of the output should match the `commit` from `product.json`.

## 8. Restart The Running Server

After replacing the files, restart the running VS Code server process or reconnect from the client so the new binaries are loaded.

## 9. Troubleshooting

### `vscode-reh-linux-x64` OOMs During `compile-src`

Symptom:

```text
FATAL ERROR: NewSpace::EnsureCurrentCapacity Allocation failed - JavaScript heap out of memory
```

Use the validated path from this guide instead:

- `core-ci`
- then `vscode-reh-linux-x64-min-ci`

The direct local task `vscode-reh-linux-x64` uses the older compile path on this branch and was not reliable on the test machine.

### `tsgo: command not found`

Make sure local binaries are on `PATH` before invoking gulp directly:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
```

### Installed Package Has No `out/server-main.js`

This usually means packaging started before `core-ci` finished. Re-run:

```bash
node --max-old-space-size=24576 --max-semi-space-size=256 ./node_modules/gulp/bin/gulp.js core-ci
node --max-old-space-size=24576 --max-semi-space-size=256 ./node_modules/gulp/bin/gulp.js vscode-reh-linux-x64-min-ci
```

Then re-sync the package into `~/.vscode-server-oss/bin/<commit>`.