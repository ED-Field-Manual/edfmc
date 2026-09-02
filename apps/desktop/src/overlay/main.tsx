import ReactDOM from 'react-dom/client';

import Overlay from './Overlay';

const container = document.getElementById('overlay-root');
if (container) {
  // No StrictMode here: the overlay's effects register native event listeners, and
  // the dev double-mount makes listener churn harder to reason about while the
  // engine's behaviour is still being validated against the live game.
  ReactDOM.createRoot(container).render(<Overlay />);
}
