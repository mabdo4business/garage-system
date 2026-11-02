"use client";

import { Button } from "../../../components/ui";

/** Opens the browser's print dialog; hidden on paper. */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
