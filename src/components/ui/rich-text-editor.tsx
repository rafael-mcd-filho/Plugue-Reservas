import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { richTextHasContent, sanitizeRichTextHtml, toSafeRichTextHtml } from '@/lib/richText';

interface RichTextEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface ToolbarAction {
  label: string;
  title: string;
  command: string;
  value?: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'Texto', title: 'Texto normal', command: 'formatBlock', value: 'p' },
  { label: 'H1', title: 'Titulo principal', command: 'formatBlock', value: 'h1' },
  { label: 'H2', title: 'Subtitulo', command: 'formatBlock', value: 'h2' },
  { label: 'B', title: 'Negrito', command: 'bold' },
  { label: 'I', title: 'Italico', command: 'italic' },
  { label: 'U', title: 'Sublinhado', command: 'underline' },
  { label: 'Lista', title: 'Lista com marcadores', command: 'insertUnorderedList' },
];

export function RichTextEditor({
  id,
  value,
  onChange,
  placeholder = 'Digite o texto...',
  disabled = false,
  className,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const safeValue = useMemo(() => toSafeRichTextHtml(value), [value]);
  const hasContent = richTextHasContent(value);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || focused) return;
    if (editor.innerHTML !== safeValue) {
      editor.innerHTML = safeValue;
    }
  }, [focused, safeValue]);

  const syncValue = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(sanitizeRichTextHtml(editor.innerHTML));
  }, [onChange]);

  const applyAction = (action: ToolbarAction) => {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(action.command, false, action.value);
    syncValue();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    const safeHtml = html ? sanitizeRichTextHtml(html) : toSafeRichTextHtml(text);
    document.execCommand('insertHTML', false, safeHtml);
    syncValue();
  };

  const handleBlur = () => {
    setFocused(false);
    const editor = editorRef.current;
    if (!editor) return;
    const sanitized = sanitizeRichTextHtml(editor.innerHTML);
    editor.innerHTML = sanitized;
    onChange(sanitized);
  };

  return (
    <div className={cn('rounded-md border border-input bg-background shadow-sm', disabled && 'opacity-60', className)}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-2">
        {TOOLBAR_ACTIONS.map((action) => (
          <button
            key={`${action.command}-${action.value ?? action.label}`}
            type="button"
            title={action.title}
            disabled={disabled}
            onMouseDown={(event) => {
              event.preventDefault();
              applyAction(action);
            }}
            className="h-8 rounded-md border border-border bg-background px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <div
          ref={editorRef}
          id={id}
          role="textbox"
          aria-multiline="true"
          aria-label="Descricao"
          contentEditable={!disabled}
          suppressContentEditableWarning
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onInput={syncValue}
          onPaste={handlePaste}
          className={cn(
            'min-h-36 w-full overflow-y-auto px-3 py-3 text-sm leading-relaxed text-foreground outline-none',
            '[&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:leading-tight',
            '[&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:leading-snug',
            '[&_p]:mb-2 [&_p]:min-h-5',
            '[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5',
            '[&_li]:mb-1',
            disabled && 'cursor-not-allowed',
          )}
        />
        {!hasContent && !focused && (
          <p className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
            {placeholder}
          </p>
        )}
      </div>
    </div>
  );
}

export function RichTextContent({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const html = useMemo(() => toSafeRichTextHtml(value), [value]);

  if (!richTextHasContent(html)) return null;

  return (
    <div
      className={cn(
        'break-words',
        '[&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:leading-tight',
        '[&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:leading-snug',
        '[&_p]:mb-2 [&_p]:leading-relaxed',
        '[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_li]:mb-1',
        '[&_*:last-child]:mb-0',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
