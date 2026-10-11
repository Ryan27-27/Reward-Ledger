import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const fmt = (n) => Number(n ?? 0).toLocaleString('en-IN');
export const inr = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const when = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const titleCase = (s) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, tone = 'info') => {
    const id = crypto.randomUUID();
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export const Spinner = () => <div className="spinner" aria-label="Loading" />;
export const Empty = ({ children }) => <div className="empty">{children}</div>;
export const ErrorBox = ({ error }) => error ? <div className="alert error" role="alert">{error.message}{error.requestId && <small> · ref {error.requestId.slice(0, 8)}</small>}</div> : null;

export function Field({ label, error, children }) {
  return <label className="field"><span>{label}</span>{children}{error && <em className="field-error">{error}</em>}</label>;
}

export function TierBadge({ tier }) {
  return <span className={`tier ${tier.toLowerCase()}`}>{titleCase(tier)}</span>;
}
