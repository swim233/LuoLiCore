import type { ReactNode } from 'react';

/* 一节的标题和一句话说明 */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="sc-sechead">
      <h2 className="sc-h2">{title}</h2>
      {children && <p className="sc-lead">{children}</p>}
    </header>
  );
}
