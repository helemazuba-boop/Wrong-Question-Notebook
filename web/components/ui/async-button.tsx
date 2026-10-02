'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';

export interface AsyncButtonProps extends ButtonProps {
  /**
   * While true the button is disabled and shows a spinner instead of its
   * leading icon. Feed it `mutation.isPending` or an await flag; this is
   * the only sanctioned in-button pending affordance.
   */
  pending?: boolean;
}

/**
 * Button with a built-in pending state. Children render as usual; pass the
 * label as children and let this component handle disabled + spinner.
 */
const AsyncButton = React.forwardRef<HTMLButtonElement, AsyncButtonProps>(
  ({ pending = false, disabled, children, className, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={className}
        {...props}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        {children}
      </Button>
    );
  }
);
AsyncButton.displayName = 'AsyncButton';

export { AsyncButton };
