'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Submit handler. Resolve → dialog closes. Throw → stays open (toast the error yourself). */
  onSubmit: () => Promise<void> | void;
  submitLabel: string;
  cancelLabel?: string;
  /**
   * External pending state (e.g. `mutation.isPending`). When provided, the
   * dialog no longer manages its own pending flag and will not auto-close;
   * close it yourself after success.
   */
  pending?: boolean;
  submitDisabled?: boolean;
  submitVariant?: 'default' | 'destructive';
}

/**
 * The single sanctioned pattern for a small dialog that submits an async
 * action: title/description, a form wrapping children, and a footer with
 * cancel + pending-aware submit. Replaces the per-dialog
 * "isLoading + fetch + toast" boilerplate; dialogs that need custom
 * footers should compose ui/dialog directly instead.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel,
  cancelLabel,
  pending: externalPending,
  submitDisabled = false,
  submitVariant = 'default',
}: FormDialogProps) {
  const managesOwnPending = externalPending !== undefined;
  const [internalPending, setInternalPending] = React.useState(false);
  const pending = managesOwnPending ? externalPending : internalPending;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || submitDisabled) return;
    if (managesOwnPending) {
      await onSubmit();
      return;
    }
    setInternalPending(true);
    try {
      await onSubmit();
      onOpenChange(false);
    } finally {
      setInternalPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          {children}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={submitVariant}
              disabled={pending || submitDisabled}
              aria-busy={pending || undefined}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
