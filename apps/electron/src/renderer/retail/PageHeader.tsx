import type { ReactNode } from 'react';

/** One page title; section headings remain h2 inside the page. */
export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return <header className="retail-page-header"><div><h1>{title}</h1>{children && <p>{children}</p>}</div>{actions && <div className="retail-inline-actions">{actions}</div>}</header>;
}
