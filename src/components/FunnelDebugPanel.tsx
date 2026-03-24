/**
 * FunnelDebugPanel — painel de debug flutuante para o funil de conversão.
 *
 * Como ativar:
 *   Adicione ?funnel_debug=1 na URL da página pública, ex:
 *   http://localhost:5173/r/meu-restaurante?funnel_debug=1
 *
 * O painel só é montado quando o parâmetro estiver presente.
 * Em produção sem o parâmetro, o componente retorna null sem custo algum.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { FunnelDebugEvent, FunnelDebugEventType } from '@/hooks/useFunnelTracking';
import { STEP_LABELS } from '@/hooks/useFunnelTracking';

const MAX_EVENTS = 50;

const TYPE_CONFIG: Record<FunnelDebugEventType, { label: string; color: string; dot: string }> = {
  queued:    { label: 'Na fila',   color: 'text-sky-700',    dot: 'bg-sky-400' },
  sent:      { label: 'Enviado',   color: 'text-emerald-700', dot: 'bg-emerald-400' },
  failed:    { label: 'Falhou',    color: 'text-red-700',     dot: 'bg-red-400' },
  retry:     { label: 'Retry',     color: 'text-amber-700',   dot: 'bg-amber-400' },
  discarded: { label: 'Descartado', color: 'text-zinc-500',   dot: 'bg-zinc-400' },
};

interface LogEntry extends FunnelDebugEvent {
  id: number;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function FunnelDebugPanel() {
  const [visible, setVisible] = useState(true);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [active, setActive] = useState(false);
  const counterRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Verifica se o parâmetro de debug está na URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('funnel_debug') === '1') {
      setActive(true);
    }
  }, []);

  // Escuta os eventos emitidos pelo useFunnelTracking
  useEffect(() => {
    if (!active) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FunnelDebugEvent>).detail;
      setEvents((prev) => {
        const next = [...prev, { ...detail, id: ++counterRef.current }];
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    window.addEventListener('funnel:debug', handler);
    return () => window.removeEventListener('funnel:debug', handler);
  }, [active]);

  // Auto-scroll para o último evento
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  if (!active) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-[9999] flex w-80 flex-col rounded-2xl border border-border bg-white/95 shadow-2xl backdrop-blur-sm transition-all duration-200',
        !visible && 'h-10 overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-2xl border-b border-border bg-zinc-900 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold text-white">Funil Debug</span>
          {events.length > 0 && (
            <span className="rounded-full bg-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
              {events.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEvents([])}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
            title="Limpar log"
          >
            Limpar
          </button>
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
            title={visible ? 'Minimizar' : 'Expandir'}
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor">
              {visible
                ? <path d="M2 7h8v1H2z" />
                : <path d="M6 2L2 7h8L6 2z" />}
            </svg>
          </button>
        </div>
      </div>

      {/* Event log */}
      {visible && (
        <div className="flex max-h-72 flex-col overflow-y-auto p-2">
          {events.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-400">
              Aguardando eventos do funil...
              <br />
              <span className="text-[10px] text-zinc-300">Acesse a página pública e avance nas etapas</span>
            </p>
          ) : (
            <div className="space-y-1">
              {events.map((ev) => {
                const cfg = TYPE_CONFIG[ev.type];
                return (
                  <div
                    key={ev.id}
                    className={cn(
                      'flex items-start gap-2 rounded-lg px-2 py-1.5 text-[11px]',
                      ev.type === 'sent' && 'bg-emerald-50',
                      ev.type === 'queued' && 'bg-sky-50',
                      ev.type === 'retry' && 'bg-amber-50',
                      ev.type === 'failed' && 'bg-red-50',
                      ev.type === 'discarded' && 'bg-zinc-50',
                    )}
                  >
                    <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', cfg.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-zinc-800">
                          {STEP_LABELS[ev.step] ?? ev.step}
                        </span>
                        <span className={cn('shrink-0 font-medium', cfg.color)}>{cfg.label}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">{ev.date}</span>
                        <span className="text-zinc-400">{formatTime(ev.timestamp)}</span>
                      </div>
                      {ev.retryCount !== undefined && ev.type === 'retry' && (
                        <span className="text-amber-600">
                          Tentativa {ev.retryCount}/{5}
                        </span>
                      )}
                      {ev.errorMessage && (
                        <p className="truncate text-red-500" title={ev.errorMessage}>
                          {ev.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {visible && (
        <div className="rounded-b-2xl border-t border-border bg-zinc-50 px-3 py-1.5">
          <p className="text-[10px] text-zinc-400">
            Ativo via <code className="rounded bg-zinc-200 px-0.5 text-zinc-600">?funnel_debug=1</code>
          </p>
        </div>
      )}
    </div>
  );
}
