import React, { useState, useEffect, useRef, type ReactNode } from 'react';
import { X, ArrowUpRight, ChevronRight, LoaderCircle } from 'lucide-react';
export type Row = Record<string, any>;
export async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
export function money(value: number | string, tenant: Row, compact = false) {
  return new Intl.NumberFormat(tenant.locale || 'en-IN', {
    style: 'currency',
    currency: tenant.currency || 'INR',
    maximumFractionDigits: compact ? 1 : 2,
    minimumFractionDigits: compact || Number(value) % 100 === 0 ? 0 : 2,
    ...(compact ? { notation: 'compact' as const } : {}),
  }).format(Number(value) / 100);
}
export function date(value: string, tenant?: Row) {
  return value
    ? new Intl.DateTimeFormat(tenant?.locale || 'en-GB', {
        day: 'numeric',
        month: 'short',
        ...(tenant?.timezone ? { timeZone: tenant.timezone } : {}),
      }).format(new Date(value))
    : 'Self-paced';
}
export function initials(name: string) {
  return name
    .replace('Dr. ', '')
    .split(' ')
    .slice(0, 2)
    .map((x) => x[0])
    .join('');
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={'badge ' + tone}>
      <i />
      {children}
    </span>
  );
}
export function Button({
  children,
  onClick,
  secondary = false,
  disabled = false,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  secondary?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      className={(secondary ? 'button secondary' : 'button') + ' ' + className}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const target = dialog.current?.querySelector<HTMLElement>('input,select,textarea,button');
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const all = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
          ) || []),
        ];
        const first = all[0],
          last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = oldOverflow;
      opener?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </section>
    </div>
  );
}
export function Form({
  onSubmit,
  children,
  label = 'Save changes',
}: {
  onSubmit: (d: FormData) => Promise<any>;
  children: ReactNode;
  label?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setError('');
        try {
          await onSubmit(data);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : null}
          {label}
        </Button>
      </div>
    </form>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">✧</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ChevronRight size={15} />
    </button>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <Badge
      tone={
        ['open', 'paid', 'verified', 'certified', 'won'].includes(value)
          ? 'positive'
          : ['pending', 'partial', 'new', 'review_required'].includes(value)
            ? 'amber'
            : value === 'rejected' || value === 'revoked'
              ? 'red'
              : 'neutral'
      }
    >
      {value.replaceAll('_', ' ')}
    </Badge>
  );
}
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-button" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={15} />
    </a>
  );
}
