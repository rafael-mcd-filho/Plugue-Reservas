import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PublicReservationExitPromptTextSize = 'body' | 'highlight';
export type PublicReservationExitPromptTextRole = 'primary' | 'secondary';
export type PublicReservationExitPromptMarkupTag = 'b' | 'u' | 'bu';

export const DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT = 'A experiência de ir ao {empresa} é {b}extraordinária{/b}.';
export const DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT_SIZE: PublicReservationExitPromptTextSize = 'body';
export const DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT = 'Todo mundo que foi ficou {u}maravilhado{/u}.';
export const DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE: PublicReservationExitPromptTextSize = 'highlight';

export const PUBLIC_RESERVATION_EXIT_PROMPT_TEXT_HELPER = 'Use {empresa}, {b}texto{/b}, {u}texto{/u} ou {bu}texto{/bu}.';

export const PUBLIC_RESERVATION_EXIT_PROMPT_SIZE_OPTIONS: Array<{
  value: PublicReservationExitPromptTextSize;
  label: string;
}> = [
  { value: 'body', label: 'Padrão' },
  { value: 'highlight', label: 'Destaque' },
];

const EXIT_PROMPT_TEMPLATE_TAG_REGEX = /\{(bu|b|u)\}([\s\S]*?)\{\/\1\}/g;

function renderMultilineText(text: string, keyPrefix: string) {
  return text.split('\n').map((line, index) => (
    <Fragment key={`${keyPrefix}-${index}`}>
      {index > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}

function getTagClassName(tag: PublicReservationExitPromptMarkupTag, emphasisTone: 'inherit' | 'foreground') {
  return cn(
    (tag === 'b' || tag === 'bu') && 'font-semibold',
    emphasisTone === 'foreground' && (tag === 'b' || tag === 'bu') && 'text-foreground',
    (tag === 'u' || tag === 'bu') && 'underline decoration-primary/35 underline-offset-[0.18em]',
  );
}

export function getPublicReservationExitPromptTextValue(value: string | null | undefined, fallback: string) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/\r\n/g, '\n');
}

export function normalizePublicReservationExitPromptTextSize(
  value: string | null | undefined,
  fallback: PublicReservationExitPromptTextSize = 'body',
): PublicReservationExitPromptTextSize {
  return value === 'body' || value === 'highlight' ? value : fallback;
}

export function getPublicReservationExitPromptTextClassName(
  role: PublicReservationExitPromptTextRole,
  size: PublicReservationExitPromptTextSize,
) {
  return cn(
    role === 'primary' ? 'text-muted-foreground' : 'font-serif italic text-primary',
    size === 'highlight'
      ? 'text-[1.32rem] leading-[1.4] sm:text-[1.55rem]'
      : role === 'secondary'
        ? 'text-[0.97rem] leading-[1.65] sm:text-[1.01rem]'
        : 'text-[0.97rem] leading-7 sm:text-[1.01rem]',
  );
}

export function renderPublicReservationExitPromptText(
  template: string,
  companyName: string,
  emphasisTone: 'inherit' | 'foreground' = 'inherit',
): ReactNode {
  const resolvedTemplate = template.replace(/\{empresa\}/g, companyName);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of resolvedTemplate.matchAll(EXIT_PROMPT_TEMPLATE_TAG_REGEX)) {
    const [fullMatch, rawTag, content = ''] = match;
    const matchStart = match.index ?? 0;

    if (matchStart > lastIndex) {
      const plainText = resolvedTemplate.slice(lastIndex, matchStart);
      nodes.push(
        <Fragment key={`plain-${matchIndex}-${lastIndex}`}>
          {renderMultilineText(plainText, `plain-${matchIndex}-${lastIndex}`)}
        </Fragment>,
      );
    }

    const tag = rawTag as PublicReservationExitPromptMarkupTag;
    nodes.push(
      <span key={`tag-${matchIndex}-${matchStart}`} className={getTagClassName(tag, emphasisTone)}>
        {renderMultilineText(content, `tag-${matchIndex}-${matchStart}`)}
      </span>,
    );

    lastIndex = matchStart + fullMatch.length;
    matchIndex += 1;
  }

  if (lastIndex < resolvedTemplate.length) {
    const plainText = resolvedTemplate.slice(lastIndex);
    nodes.push(
      <Fragment key={`plain-tail-${lastIndex}`}>
        {renderMultilineText(plainText, `plain-tail-${lastIndex}`)}
      </Fragment>,
    );
  }

  if (nodes.length === 0) {
    return null;
  }

  return <>{nodes}</>;
}
