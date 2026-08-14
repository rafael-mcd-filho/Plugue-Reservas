import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface InfoTooltipProps {
  content: string;
  ariaLabel?: string;
  className?: string;
  interaction?: 'tooltip' | 'popover';
}

export default function InfoTooltip({
  content,
  ariaLabel = 'Entender esta métrica',
  className,
  interaction = 'tooltip',
}: InfoTooltipProps) {
  const trigger = (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        interaction === 'popover' ? 'h-6 w-6' : 'h-5 w-5',
        className,
      )}
    >
      <Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  if (interaction === 'popover') {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side="top"
          collisionPadding={12}
          className="w-auto max-w-[min(20rem,calc(100vw-2rem))] px-3 py-2 text-sm leading-relaxed"
        >
          <p>{content}</p>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent className="max-w-xs text-sm">
          <p>{content}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
