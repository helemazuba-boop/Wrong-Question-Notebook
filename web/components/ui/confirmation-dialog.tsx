'use client';

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

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'default' | 'destructive';
}

/**
 * Confirmation modal built on the shared Radix Dialog (focus trap,
 * Escape, overlay click, aria wiring all inherited).
 *
 * Compatibility with the legacy hand-rolled modal: confirm/cancel hide the
 * dialog immediately and then invoke the callback, so consumers that rely
 * on auto-close and those that flip `isOpen` themselves both keep working.
 */
export function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmText = '',
  cancelText = '',
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmationDialogProps) {
  const [acted, setActed] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(isOpen);

  // Adjust state during render (React's recommended alternative to a
  // resetting effect): reopening the dialog clears the acted flag.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setActed(false);
  }

  const open = isOpen && !acted;

  const handleConfirm = () => {
    setActed(true);
    onConfirm();
  };

  const handleCancel = () => {
    setActed(true);
    onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={next => (!next ? handleCancel() : null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Hook for easier usage
export function useConfirmationDialog() {
  const [dialog, setDialog] = React.useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
  } | null>(null);

  const showConfirmation = (config: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
  }) => {
    setDialog({
      isOpen: true,
      ...config,
    });
  };

  const hideConfirmation = () => {
    setDialog(null);
  };

  const ConfirmationDialogComponent = dialog ? (
    <ConfirmationDialog
      isOpen={dialog.isOpen}
      title={dialog.title}
      message={dialog.message}
      confirmText={dialog.confirmText}
      cancelText={dialog.cancelText}
      variant={dialog.variant}
      onConfirm={dialog.onConfirm}
      onCancel={hideConfirmation}
    />
  ) : null;

  return {
    showConfirmation,
    ConfirmationDialogComponent,
  };
}
