// client/src/shared/ui/DataTable.tsx — milestone 14, from project/Main.dc.html.
//
// The dashboard table, and the board's note about it: "On mobile, rows become stacked cards with the
// same fields in the same order."
//
// THAT IS THE WHOLE DESIGN. One component, two layouts, driven by a CSS breakpoint rather than by
// JavaScript measuring the window — so there is no flash of the wrong layout and no resize listener.
// The header row hides below the breakpoint and each row becomes a card whose cells carry their own
// labels.

import type { ReactNode } from 'react';

export type Column<Row> = {
  key: string;
  header: string;
  /** A grid track width, e.g. '90px' or 'minmax(0,1fr)'. */
  width: string;
  cell: (row: Row) => ReactNode;
  /** Monospace, for order numbers and SKUs — the boards use JetBrains Mono for codes. */
  mono?: boolean;
};

type Props<Row> = {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Rendered in place of rows when there are none — an EmptyState, usually. */
  empty?: ReactNode;
};

export function DataTable<Row>({ caption, columns, rows, rowKey, empty }: Props<Row>): ReactNode {
  const template = columns.map((c) => c.width).join(' ');

  if (rows.length === 0 && empty !== undefined) {
    return <div className="overflow-hidden rounded-card border border-line bg-surface">{empty}</div>;
  }

  return (
    <div className="overflow-hidden rounded-card border border-line text-body">
      <span className="sr-only">{caption}</span>

      {/* The header exists only in the table layout. Below the breakpoint each cell labels itself. */}
      <div
        className="hidden gap-2 bg-ground px-3.5 py-2.5 text-caption font-semibold text-muted sm:grid"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((column) => (
          <span key={column.key}>{column.header}</span>
        ))}
      </div>

      {rows.map((row, index) => (
        <div
          key={rowKey(row)}
          // Zebra striping from the board — every second row on #FAFAF7, which is `line-subtle`.
          className={`flex flex-col gap-1 border-t border-line-subtle p-3.5 sm:grid sm:items-center sm:gap-2 ${
            index % 2 === 1 ? 'bg-line-subtle' : 'bg-surface'
          }`}
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((column) => (
            <span key={column.key} className={`flex gap-2 sm:block ${column.mono === true ? 'font-mono text-mono' : ''}`}>
              {/* The label is the header, repeated per cell and hidden at table width. */}
              <span aria-hidden="true" className="w-24 shrink-0 text-caption font-semibold text-muted sm:hidden">
                {column.header}
              </span>
              {column.cell(row)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
