// Installs the Node filesystem adapter as the ambient default for the test run.
// The core package deliberately has no `node:` imports so that webview bundles
// stay clean; Node hosts opt in with this single side-effecting import.
import './src/node.js';
