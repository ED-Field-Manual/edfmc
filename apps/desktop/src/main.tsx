import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';

/**
 * Render failures must be visible.
 *
 * A crash during render leaves an empty <div id="root">, and because the theme
 * background is painted by CSS the window still looks "correct" — just blank. That
 * is the worst possible failure mode: it looks like a hang, not an error. This
 * boundary and the handlers below put the actual message on screen.
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Render failed', error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={panel}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.125rem' }}>EDFM Companion failed to start</h1>
        <p style={{ color: '#8b98a5', margin: '0 0 1rem' }}>
          The interface could not render. The message below is the cause.
        </p>
        <pre style={pre}>{this.state.error.stack ?? String(this.state.error)}</pre>
      </div>
    );
  }
}

const panel: React.CSSProperties = {
  padding: '1.5rem',
  fontFamily: '"Segoe UI", system-ui, sans-serif',
  color: '#e6edf3',
  background: '#0d1117',
  minHeight: '100vh',
};

const pre: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #2a3441',
  borderRadius: 6,
  padding: '0.75rem',
  overflow: 'auto',
  fontSize: '0.75rem',
  whiteSpace: 'pre-wrap',
};

function showFatal(title: string, detail: string) {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML =
    `<div style="padding:1.5rem;font-family:Segoe UI,system-ui,sans-serif;color:#e6edf3">` +
    `<h1 style="font-size:1.125rem;margin:0 0 .5rem">${title}</h1>` +
    `<pre style="background:#161b22;border:1px solid #2a3441;border-radius:6px;` +
    `padding:.75rem;white-space:pre-wrap;font-size:.75rem">${
      detail.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))
    }</pre></div>`;
}

// Errors thrown outside React's render cycle never reach the boundary.
window.addEventListener('error', (e) => showFatal('EDFM Companion error', String(e.error ?? e.message)));
window.addEventListener('unhandledrejection', (e) =>
  showFatal('EDFM Companion error', String((e as PromiseRejectionEvent).reason)),
);

const container = document.getElementById('root');
if (!container) {
  document.body.textContent = 'Fatal: #root element missing from index.html';
} else {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
