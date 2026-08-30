import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  BellRing,
  CalendarCheck2,
  CalendarX2,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  HeartHandshake,
  Link2,
  ListChecks,
  Menu,
  ShieldCheck,
  Sparkles,
  Table2,
  TrendingUp,
  UsersRound,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import { useSystemBranding } from '@/hooks/useSettings';
import { useFaviconOverride } from '@/lib/publicCompanyIcons';

const NAV_LINKS = [
  { href: '#desafio', label: 'O problema' },
  { href: '#como-ajuda', label: 'Como funciona' },
  { href: '#resultados', label: 'Relatórios' },
  { href: '#duvidas', label: 'Dúvidas' },
];

const PAIN_MOMENTS = [
  {
    icon: Clock3,
    moment: 'Antes do serviço',
    title: 'Você abre a casa sem saber quanto do salão já está vendido',
    description:
      'Um pedido no WhatsApp, outro no Instagram e mais um anotado no papel. Ninguém consegue dizer com segurança quantas mesas já estão comprometidas hoje.',
  },
  {
    icon: BellRing,
    moment: 'No meio do movimento',
    title: 'Cada reserva nova depende de alguém parar para conferir',
    description:
      'Reservar vira uma conversa de dez mensagens. Enquanto isso, o cliente espera resposta, a recepção perde o salão de vista e a agenda fica desatualizada.',
  },
  {
    icon: BarChart3,
    moment: 'Na hora de fechar',
    title: 'Duas mesas furaram e isso não fica registrado em lugar nenhum',
    description:
      'A perda acontece, mas some junto com o fim do serviço. Sem registro, ninguém sabe quanto a casa deixou de faturar nem qual horário está sangrando.',
  },
];

const ROUTINE_STEPS = [
  {
    number: '01',
    title: 'A reserva entra pronta, sem conversa',
    description:
      'O cliente vê só os horários que a casa consegue atender, escolhe e preenche os dados sozinho. Ninguém da equipe precisa parar o serviço para responder.',
  },
  {
    number: '02',
    title: 'A confirmação corre no automático',
    description:
      'Confirmação, lembrete e aviso de cancelamento saem sozinhos pelo WhatsApp. Cada resposta do cliente atualiza a agenda, então o número que você vê é real.',
  },
  {
    number: '03',
    title: 'Você abre a noite sabendo o que vem',
    description:
      'Antes do serviço, a casa já mostra quantas mesas estão comprometidas, em quais horários e com quantas pessoas. Dá para acertar escala, compra e salão com antecedência.',
  },
  {
    number: '04',
    title: 'O relatório fecha a noite por você',
    description:
      'Quantas reservas entraram, quantas furaram, qual horário lotou e quanto a casa deixou na mesa. Na semana seguinte, você decide com número na mão e não no achismo.',
  },
];

const CORE_BENEFITS = [
  {
    icon: CalendarCheck2,
    title: 'Enxergue a noite antes de ela começar',
    description:
      'A agenda mostra quanto de cada horário já está comprometido e quanto ainda cabe. O cliente só vê o que a casa dá conta de atender, então não entra reserva demais no mesmo horário.',
    proof: 'Ocupação prevista por horário, antes de a primeira mesa sentar.',
  },
  {
    icon: CalendarX2,
    title: 'A mesa que fura deixa de ser invisível',
    description:
      'A confirmação e o lembrete correm sozinhos para reduzir o esquecimento. O que mesmo assim não aparece fica registrado como perda, com horário e tamanho do grupo.',
    proof: 'Cancelamento e ausência entram na conta, em vez de sumirem no fim do serviço.',
  },
  {
    icon: ListChecks,
    title: 'A espera vira processo, não improviso',
    description:
      'O cliente entra na fila e acompanha posição e tempo estimado pelo próprio celular, enquanto a recepção chama os próximos na ordem, sem perder o salão de vista.',
    proof: 'Quem esperou, quem desistiu e quanto tempo levou fica tudo registrado.',
  },
  {
    icon: HeartHandshake,
    title: 'Saiba quem é o cliente antes de ele sentar',
    description:
      'Quantas vezes já veio, quando foi a última, há quanto tempo sumiu e quantas vezes já furou. Dá para receber pelo nome e tratar cada caso como ele merece.',
    proof: 'Histórico de visitas no sistema, e não na memória da equipe.',
  },
];

const EXTRA_BENEFITS = [
  {
    icon: CreditCard,
    title: 'Cobre um sinal onde a perda dói mais',
    description:
      'Data comemorativa, mesa de doze, menu fechado. Quando o furo sai caro, peça um sinal no Pix ou no cartão antes de confirmar e proteja a noite inteira.',
  },
  {
    icon: Table2,
    title: 'Cada grupo na mesa certa',
    description:
      'Separe as mesas por ambiente — salão, varanda, área externa — e encaixe cada reserva no lugar que combina com o tamanho do grupo.',
  },
  {
    icon: UsersRound,
    title: 'Cada um vê só o que precisa',
    description:
      'A recepção trabalha na agenda do dia, o gerente acompanha a casa inteira e os números do negócio ficam com quem precisa deles.',
  },
  {
    icon: Link2,
    title: 'Descubra quem realmente manda cliente para você',
    description:
      'Veja de onde vieram as reservas — o hotel da esquina, o parceiro que indica, a divulgação que você paga — e invista onde traz movimento.',
  },
];

const FAQ_ITEMS = [
  {
    question: 'O cliente precisa instalar algum aplicativo?',
    answer:
      'Não. Ele abre o link do restaurante no celular, reserva a mesa ou entra na fila. Não baixa nada e não cria senha.',
  },
  {
    question: 'Como o cliente recebe a confirmação e o lembrete?',
    answer:
      'Pelo WhatsApp conectado ao restaurante, no automático. Mais importante: a resposta do cliente atualiza a agenda, então o número de mesas confirmadas que você vê é o número real.',
  },
  {
    question: 'E quando a casa lota e forma fila na porta?',
    answer:
      'O cliente entra na fila pelo celular e acompanha a posição e o tempo estimado. A recepção chama os próximos pelo sistema, sem lista no papel.',
  },
  {
    question: 'Preciso dar acesso a tudo para a equipe?',
    answer:
      'Não. Você libera só o que cada função usa: a recepção fica na agenda do dia, o gerente acompanha a casa e os relatórios ficam com você.',
  },
  {
    question: 'Isso resolve o problema de quem reserva e não aparece?',
    answer:
      'Ataca por dois lados: a confirmação e o lembrete diminuem o esquecimento, e o sinal antecipado segura as mesas maiores. O que ainda assim furar fica registrado, para você saber o tamanho real da perda. Quanto isso melhora depende de cada casa, por isso não prometemos um número aqui.',
  },
  {
    question: 'Que tipo de relatório eu tenho no fim do mês?',
    answer:
      'Ocupação por horário e por dia, reservas confirmadas, canceladas e não comparecidas, tempo de espera na fila, origem das reservas e retorno de clientes. Tudo com base no que aconteceu de verdade na casa.',
  },
];

function BrandMark({
  systemName,
  systemLogo,
  size = 'md',
}: {
  systemName: string;
  systemLogo: string;
  size?: 'sm' | 'md';
}) {
  const pixels = size === 'sm' ? 28 : 34;
  const dimension = size === 'sm' ? 'h-7 w-7' : 'h-[34px] w-[34px]';

  if (systemLogo) {
    return (
      <img
        src={systemLogo}
        alt={systemName}
        width={pixels}
        height={pixels}
        {...{ fetchpriority: 'high' }}
        className={dimension + ' rounded-lg object-contain'}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={
        'flex ' +
        dimension +
        ' items-center justify-center rounded-lg bg-[#ca6c35] text-white shadow-[0_8px_20px_-12px_rgba(202,108,53,0.9)]'
      }
    >
      <UtensilsCrossed className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
    </span>
  );
}

function NavBar({ systemName, systemLogo }: { systemName: string; systemLogo: string }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-[#251d17]/10 bg-[#f8f4ec]/90 backdrop-blur-xl">
      <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between px-5 sm:px-8">
        <a
          href="#topo"
          className="flex min-w-0 flex-1 items-center gap-2.5 sm:flex-none"
          aria-label={'Ir para o início de ' + systemName}
        >
          <BrandMark systemName={systemName} systemLogo={systemLogo} />
          <span
            translate="no"
            className="min-w-0 max-w-[11rem] truncate text-sm font-semibold tracking-[-0.01em] text-[#211a15] sm:max-w-none sm:text-base"
          >
            {systemName}
          </span>
        </a>

        <nav aria-label="Navegação principal" className="hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-[#6f635a] transition-colors duration-150 hover:text-[#211a15]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            asChild
            variant="ghost"
            className="hidden h-11 rounded-full px-4 text-[#4b4038] hover:bg-[#efe7da] hover:text-[#211a15] sm:inline-flex"
          >
            <Link to="/login">Entrar</Link>
          </Button>
          <Button
            asChild
            className="hidden h-11 rounded-full bg-[#211a15] px-5 text-white shadow-[0_10px_24px_-14px_rgba(33,26,21,0.9)] hover:bg-[#3a2f27] lg:inline-flex"
          >
            <a href="#como-ajuda">
              Ver como funciona
              <ArrowRight aria-hidden="true" />
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 rounded-full px-3 text-[#342922] hover:bg-[#eee7da] lg:hidden"
            aria-expanded={mobileMenuOpen}
            aria-controls="menu-mobile"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {mobileMenuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            Menu
          </Button>
        </div>
      </div>
      {mobileMenuOpen ? (
        <nav
          id="menu-mobile"
          aria-label="Navegação para celular"
          className="absolute inset-x-0 top-full border-y border-[#251d17]/10 bg-[#fbf8f2] px-5 py-4 shadow-[0_18px_34px_-24px_rgba(37,29,23,0.5)] lg:hidden"
        >
          <div className="mx-auto grid max-w-7xl gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-[#4b4038] hover:bg-[#eee7da] hover:text-[#211a15]"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/login"
              className="mt-2 flex min-h-11 items-center justify-between rounded-xl bg-[#211a15] px-3 text-sm font-semibold text-white hover:bg-[#3a2f27]"
              onClick={() => setMobileMenuOpen(false)}
            >
              Entrar no painel
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function HeroPreviewPanel() {
  const reservations = [
    { time: '19:00', label: 'Casal · mesa 12 reservada', status: 'Confirmada', tone: 'green' },
    { time: '19:30', label: '4 pessoas · lembrete enviado', status: 'Lembrado', tone: 'orange' },
    { time: '20:00', label: '3 pessoas · encaixe na varanda', status: 'Organizada', tone: 'green' },
  ];

  return (
    <div className="relative mx-auto w-full max-w-[34rem] lg:mr-0">
      <div aria-hidden="true" className="absolute -left-8 top-14 h-56 w-56 rounded-full bg-[#e9a673]/30 blur-3xl" />
      <div aria-hidden="true" className="absolute -right-8 bottom-4 h-52 w-52 rounded-full bg-[#6d8b78]/20 blur-3xl" />

      <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#211a15] p-4 shadow-[0_34px_80px_-38px_rgba(37,29,23,0.75)] sm:p-5">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle_at_top_right,rgba(232,163,110,0.34),transparent_38%)]"
        />
        <div className="relative rounded-[1.35rem] bg-[#fbf8f2] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4 border-b border-[#2c241d]/10 pb-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#9a6a46]">Hoje no salão</p>
              <p className="mt-1 text-base font-semibold text-[#211a15]">Você já sabe como a noite vai ser</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e7efe9] px-2.5 py-1 text-[11px] font-semibold text-[#365646]">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#4f7a63]" />
              Tudo em ordem
            </span>
          </div>

          <div className="mt-4 space-y-2.5">
            {reservations.map((reservation) => (
              <div
                key={reservation.time}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-[#2c241d]/10 bg-white px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="font-display text-lg font-semibold text-[#211a15]">{reservation.time}</span>
                <span className="min-w-0 text-xs leading-5 text-[#6f635a] sm:text-sm">{reservation.label}</span>
                <span
                  className={
                    'col-start-2 w-fit rounded-full px-2 py-1 text-[11px] font-semibold sm:col-start-auto ' +
                    (reservation.tone === 'green'
                      ? 'bg-[#e7efe9] text-[#365646]'
                      : 'bg-[#faeadc] text-[#a4572c]')
                  }
                >
                  {reservation.status}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[#eee7da] p-3.5">
              <div className="flex items-center gap-2 text-[#7b5b43]">
                <Table2 aria-hidden="true" className="h-4 w-4" />
                <span className="text-xs font-semibold">Ocupação prevista</span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-[#6f635a]">A casa já sabe quanto do salão está comprometido.</p>
            </div>
            <div className="rounded-xl bg-[#e7efe9] p-3.5">
              <div className="flex items-center gap-2 text-[#365646]">
                <CalendarX2 aria-hidden="true" className="h-4 w-4" />
                <span className="text-xs font-semibold">Perda registrada</span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-[#557062]">O que cancela ou não aparece entra no relatório.</p>
            </div>
          </div>

          <p className="mt-3 text-center text-[11px] text-[#74685f]">Exemplo ilustrativo de uma noite</p>
        </div>
      </div>

      <div className="absolute -left-10 top-24 hidden items-center gap-2 rounded-full border border-[#2c241d]/10 bg-white px-3 py-2 text-xs font-semibold text-[#365646] shadow-[0_16px_34px_-18px_rgba(37,29,23,0.45)] sm:flex">
        <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
        Noite prevista
      </div>
      <div className="absolute -bottom-5 right-8 hidden items-center gap-2 rounded-full border border-[#2c241d]/10 bg-[#f4c973] px-3 py-2 text-xs font-semibold text-[#3b2a1d] shadow-[0_16px_34px_-18px_rgba(37,29,23,0.45)] sm:flex">
        <Sparkles aria-hidden="true" className="h-4 w-4" />
        Sem furo na agenda
      </div>
    </div>
  );
}

function Hero({ systemName }: { systemName: string }) {
  return (
    <section id="topo" className="relative scroll-mt-24 overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 [background-image:radial-gradient(circle_at_14%_16%,rgba(202,108,53,0.11),transparent_24%),radial-gradient(circle_at_86%_5%,rgba(63,90,78,0.12),transparent_24%)]"
      />
      <div className="mx-auto grid max-w-7xl gap-14 px-5 pb-24 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:gap-16 lg:pb-32 lg:pt-24">
        <div className="animate-slide-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#2c241d]/10 bg-white/75 px-3 py-1.5 text-xs font-semibold text-[#705c4d] shadow-[0_8px_24px_-20px_rgba(37,29,23,0.6)]">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#ca6c35]" />
            Reserva descomplicada. Noite sem surpresa.
          </span>

          <h1 className="mt-6 max-w-3xl text-balance font-display text-[2.75rem] font-semibold leading-[0.98] tracking-[-0.045em] text-[#211a15] sm:text-6xl lg:text-[4.4rem]">
            Saiba como vai ser a sua noite <span className="text-[#b95f32]">antes de abrir a porta</span>.
          </h1>

          <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-[#665b53] sm:text-lg sm:leading-8">
            Com o <span translate="no" className="font-semibold text-[#342922]">{systemName}</span>, a reserva entra pronta e sem
            conversa, cada mesa perdida fica registrada e os relatórios mostram a ocupação real da casa. Você para de
            administrar o salão no escuro.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              className="h-12 rounded-full bg-[#a9572d] px-6 text-base text-white shadow-[0_14px_32px_-18px_rgba(169,87,45,0.9)] hover:bg-[#91451f]"
            >
              <a href="#como-ajuda">
                Ver como funciona na prática
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
            <Button
              asChild
              variant="outline"
              className="h-12 rounded-full border-[#2c241d]/15 bg-white/70 px-6 text-base text-[#342922] hover:bg-white hover:text-[#211a15]"
            >
              <Link to="/login">Entrar no painel</Link>
            </Button>
          </div>

          <ul className="mt-8 grid gap-3 text-sm text-[#665b53] sm:grid-cols-3">
            {['Noite previsível', 'Reserva descomplicada', 'Perdas sob controle'].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#e6eee8] text-[#3f6853]">
                  <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-slide-up [animation-delay:120ms]">
          <HeroPreviewPanel />
        </div>
      </div>
    </section>
  );
}

function OutcomeStrip() {
  const outcomes = [
    ['Reserva descomplicada', 'O cliente reserva sozinho e a informação já entra pronta.'],
    ['Perda sob controle', 'Cancelamento, ausência e desistência ficam registrados.'],
    ['Noite previsível', 'Você sabe o que esperar de cada horário antes de abrir.'],
  ];

  return (
    <section aria-label="Principais ganhos" className="border-y border-[#2c241d]/10 bg-white/55">
      <div className="mx-auto grid max-w-7xl divide-y divide-[#2c241d]/10 px-5 sm:px-8 md:grid-cols-3 md:divide-x md:divide-y-0">
        {outcomes.map(([title, description]) => (
          <div key={title} className="py-6 md:px-8 md:first:pl-0 md:last:pr-0">
            <p className="font-display text-xl font-semibold text-[#211a15]">{title}</p>
            <p className="mt-1 text-sm leading-6 text-[#6f635a]">{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'center',
  theme = 'light',
}: {
  eyebrow: string;
  title: string;
  description?: string;
  align?: 'left' | 'center';
  theme?: 'light' | 'dark';
}) {
  const centered = align === 'center';
  const dark = theme === 'dark';

  return (
    <div className={centered ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl'}>
      <p className={'text-xs font-semibold uppercase tracking-[0.18em] ' + (dark ? 'text-[#e7a376]' : 'text-[#a9572d]')}>
        {eyebrow}
      </p>
      <h2
        className={
          'mt-4 text-balance font-display text-4xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-5xl ' +
          (dark ? 'text-[#fbf7f0]' : 'text-[#211a15]')
        }
      >
        {title}
      </h2>
      {description ? (
        <p
          className={
            'mt-5 text-pretty text-base leading-7 sm:text-lg ' +
            (dark ? 'text-[#c9beb6]' : 'text-[#6f635a]')
          }
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

function ProblemSection() {
  return (
    <section id="desafio" className="scroll-mt-24 bg-[#211a15] py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="O problema não é esforço, é falta de previsão"
          title="Você só descobre como foi a noite quando ela já acabou."
          description="Sua equipe já corre o suficiente. O que falta é enxergar a casa antes do serviço, tirar a reserva do improviso e saber, no fim, quanto ficou pelo caminho."
          theme="dark"
        />

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {PAIN_MOMENTS.map((item) => (
            <article
              key={item.moment}
              className="group rounded-[1.5rem] border border-white/10 bg-white/[0.055] p-6 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.08] sm:p-7"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#e7a376]">{item.moment}</span>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-[#f7e6d8]">
                  <item.icon aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
              </div>
              <h3 className="mt-7 text-balance font-display text-2xl font-semibold leading-tight text-[#fbf7f0]">
                {item.title}
              </h3>
              <p className="mt-3 text-sm leading-7 text-[#c9beb6]">{item.description}</p>
            </article>
          ))}
        </div>

        <div className="mt-10 grid gap-6 border-t border-white/10 pt-8 md:grid-cols-[auto_1fr] md:items-start">
          <span aria-hidden="true" className="font-display text-5xl leading-none text-[#ca6c35]">“</span>
          <p className="max-w-4xl text-pretty font-display text-2xl leading-snug text-[#f3ede5] sm:text-3xl">
            No fim da noite, ninguém lembra da mesa que ficou vazia às 20h. No fim do mês, ela aparece no caixa e ninguém
            sabe explicar de onde veio.
          </p>
        </div>
      </div>
    </section>
  );
}

function RoutineSection() {
  return (
    <section id="como-ajuda" className="scroll-mt-24 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="Como funciona no dia a dia"
          title="Da reserva ao relatório, sem buraco no meio."
          description="São quatro etapas. Cada uma tira uma decisão do achismo e nenhuma delas exige que a sua equipe vire especialista em sistema."
        />

        <div className="relative mt-16">
          <div
            aria-hidden="true"
            className="absolute left-[12.5%] right-[12.5%] top-8 hidden h-px bg-[#2c241d]/15 lg:block"
          />
          <ol className="grid gap-5 lg:grid-cols-4">
            {ROUTINE_STEPS.map((step) => (
              <li
                key={step.number}
                className="relative rounded-[1.5rem] border border-[#2c241d]/10 bg-white p-6 shadow-[0_18px_45px_-38px_rgba(37,29,23,0.55)]"
              >
                <span className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border-[6px] border-[#f8f4ec] bg-[#a9572d] font-display text-lg font-semibold text-white shadow-[0_12px_24px_-14px_rgba(169,87,45,0.85)]">
                  {step.number}
                </span>
                <h3 className="mt-6 text-balance font-display text-2xl font-semibold leading-tight text-[#211a15]">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#6f635a]">{step.description}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function BenefitsSection() {
  return (
    <section id="beneficios" className="scroll-mt-24 bg-[#eee7da] py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="O que muda na casa"
          title="Previsão no lugar do improviso."
          description="Não é lista de recurso. É o que muda quando a reserva entra organizada, a perda fica visível e a noite deixa de ser surpresa."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {CORE_BENEFITS.map((benefit, index) => {
            const dark = index === 0 || index === 3;
            return (
              <article
                key={benefit.title}
                className={
                  'group relative overflow-hidden rounded-[1.75rem] border border-[#2c241d]/10 p-7 transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_24px_50px_-38px_rgba(37,29,23,0.6)] sm:p-8 ' +
                  (dark ? 'bg-[#211a15] text-white' : 'bg-[#fbf8f2]')
                }
              >
                <div
                  aria-hidden="true"
                  className={
                    'absolute -right-12 -top-12 h-36 w-36 rounded-full blur-2xl ' +
                    (dark ? 'bg-[#ca6c35]/25' : 'bg-[#ca6c35]/10')
                  }
                />
                <span
                  className={
                    'relative flex h-12 w-12 items-center justify-center rounded-2xl ' +
                    (dark ? 'bg-white/10 text-[#f2b488]' : 'bg-[#f6dfcf] text-[#a9572d]')
                  }
                >
                  <benefit.icon aria-hidden="true" className="h-5 w-5" />
                </span>
                <h3
                  className={
                    'relative mt-8 max-w-lg text-balance font-display text-3xl font-semibold leading-tight ' +
                    (dark ? 'text-[#fbf7f0]' : 'text-[#211a15]')
                  }
                >
                  {benefit.title}
                </h3>
                <p
                  className={
                    'relative mt-4 max-w-xl text-sm leading-7 sm:text-base ' +
                    (dark ? 'text-[#c9beb6]' : 'text-[#6f635a]')
                  }
                >
                  {benefit.description}
                </p>
                <div
                  className={
                    'relative mt-6 flex items-start gap-2.5 border-t pt-5 text-sm font-medium ' +
                    (dark ? 'border-white/10 text-[#ead8cb]' : 'border-[#2c241d]/10 text-[#4e443d]')
                  }
                >
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#ca6c35]" />
                  <span>{benefit.proof}</span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function InsightPanel() {
  const bars = [42, 58, 78, 94, 72, 54];

  return (
    <figure className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#17130f] p-5 shadow-[0_30px_70px_-42px_rgba(0,0,0,0.8)] sm:p-7">
      <div
        aria-hidden="true"
        className="absolute inset-0 [background-image:radial-gradient(circle_at_top_right,rgba(202,108,53,0.25),transparent_34%)]"
      />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#e7a376]">Ocupação por horário</p>
          <p className="mt-2 font-display text-2xl font-semibold text-[#fbf7f0]">Onde vale mexer na casa</p>
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-[#bdb2aa]">
          Exemplo
        </span>
      </div>

      <div
        className="relative mt-8 grid grid-cols-6 items-end gap-2 border-b border-white/10 pb-3 sm:gap-3"
        aria-hidden="true"
      >
        {bars.map((height, index) => (
          <div key={height} className="flex h-44 items-end rounded-t-lg bg-white/[0.04]">
            <div
              className={'w-full rounded-t-lg ' + (index === 3 ? 'bg-[#e68a51]' : 'bg-[#657f6e]')}
              style={{ height: height + '%' }}
            />
          </div>
        ))}
      </div>
      <div className="relative mt-3 grid grid-cols-6 gap-2 text-center text-[11px] text-[#a89d95] sm:text-xs">
        {['18h', '19h', '20h', '21h', '22h', '23h'].map((hour) => (
          <span key={hour}>{hour}</span>
        ))}
      </div>

      <div className="relative mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white/[0.06] p-4">
          <p className="text-xs text-[#a89d95]">Horário mais disputado</p>
          <p className="mt-1 font-display text-xl font-semibold text-[#fbf7f0]">21h está no limite</p>
        </div>
        <div className="rounded-xl bg-[#26352d] p-4">
          <p className="text-xs text-[#afc1b6]">Onde sobra mesa</p>
          <p className="mt-1 font-display text-xl font-semibold text-[#edf5ef]">19h dá para encher</p>
        </div>
      </div>
      <figcaption className="relative mt-4 text-center text-[11px] text-[#a89d95]">
        Exemplo ilustrativo, sem dados reais de clientes.
      </figcaption>
    </figure>
  );
}

function ResultsSection() {
  const insights = [
    ['Ocupação por horário e por dia', 'Veja quanto da casa foi ocupado em cada faixa e acerte escala, compra e salão com antecedência.'],
    ['Perdas com hora e tamanho', 'Cancelamento, ausência e desistência de fila somados, para você saber quanto a casa deixou na mesa.'],
    ['Onde o cliente desiste de reservar', 'Compare quem começou a reserva com quem chegou até o fim e veja onde o processo trava.'],
    ['Quem volta e quem sumiu', 'Acompanhe a frequência de cada cliente e chame de volta quem não aparece há meses.'],
  ];

  return (
    <section id="resultados" className="scroll-mt-24 bg-[#3d574a] py-24 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-14 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-20">
        <div>
          <SectionHeading
            eyebrow="Relatórios avançados"
            title="Veja o que a correria da noite esconde."
            description="Toda noite a sua casa gera número. Aqui ele vira resposta simples: quanto do salão foi ocupado, quanto se perdeu com mesa vazia e quais horários sustentam o seu mês."
            align="left"
            theme="dark"
          />

          <ul className="mt-9 space-y-5">
            {insights.map(([title, description]) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#f0bd85] text-[#3a2b20]">
                  <TrendingUp aria-hidden="true" className="h-3.5 w-3.5" />
                </span>
                <div>
                  <p className="font-semibold text-[#fbf7f0]">{title}</p>
                  <p className="mt-1 text-sm leading-6 text-[#cfdbd3]">{description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <InsightPanel />
      </div>
    </section>
  );
}

function ExtraBenefitsSection() {
  return (
    <section className="py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="Para quando a casa cresce"
          title="Mais movimento sem perder o controle."
          description="Abrir mais horário, mais ambiente ou mais uma unidade não precisa custar previsibilidade."
        />

        <div className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {EXTRA_BENEFITS.map((benefit) => (
            <article key={benefit.title} className="border-t border-[#2c241d]/15 pt-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2dfd0] text-[#a9572d]">
                <benefit.icon aria-hidden="true" className="h-[18px] w-[18px]" />
              </span>
              <h3 className="mt-5 text-balance font-display text-2xl font-semibold leading-tight text-[#211a15]">
                {benefit.title}
              </h3>
              <p className="mt-3 text-sm leading-7 text-[#6f635a]">{benefit.description}</p>
            </article>
          ))}
        </div>
        <p className="mx-auto mt-10 max-w-3xl text-center text-xs leading-6 text-[#786c63]">
          Alguns recursos, como os avisos pelo WhatsApp, os relatórios detalhados e o sinal antecipado, dependem do plano
          contratado e da configuração de cada casa.
        </p>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section id="duvidas" className="scroll-mt-24 border-y border-[#2c241d]/10 bg-white/55 py-24 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 sm:px-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a9572d]">Dúvidas comuns</p>
          <h2 className="mt-4 text-balance font-display text-4xl font-semibold leading-[1.04] tracking-[-0.035em] text-[#211a15] sm:text-5xl">
            Perguntas que todo dono de restaurante faz.
          </h2>
          <p className="mt-5 text-pretty text-base leading-7 text-[#6f635a]">
            Sem enrolação e sem palavra difícil: o que muda na sua agenda, na sua perda e no seu relatório.
          </p>
        </div>

        <div className="divide-y divide-[#2c241d]/10 border-y border-[#2c241d]/10">
          {FAQ_ITEMS.map((item) => (
            <details key={item.question} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-5 text-left font-semibold text-[#2d241e] transition-colors duration-150 hover:text-[#a9572d] [&::-webkit-details-marker]:hidden">
                <span>{item.question}</span>
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#2c241d]/15 text-lg font-normal transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-2xl pb-6 pr-10 text-sm leading-7 text-[#6f635a]">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingCta({ systemName }: { systemName: string }) {
  return (
    <section className="px-5 py-20 sm:px-8 sm:py-24">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-[#a9572d] px-6 py-14 text-center shadow-[0_30px_70px_-42px_rgba(151,69,31,0.8)] sm:px-12 sm:py-20">
        <div aria-hidden="true" className="absolute -left-24 -top-24 h-72 w-72 rounded-full border-[54px] border-white/10" />
        <div
          aria-hidden="true"
          className="absolute -bottom-28 -right-20 h-72 w-72 rounded-full border-[48px] border-[#7f3f20]/20"
        />
        <ShieldCheck aria-hidden="true" className="relative mx-auto h-9 w-9 text-[#ffe9d8]" />
        <h2 className="relative mx-auto mt-6 max-w-3xl text-balance font-display text-4xl font-semibold leading-[1.04] tracking-[-0.035em] text-white sm:text-5xl">
          Toda noite a sua casa te dá um número. Você só não está olhando para ele.
        </h2>
        <p className="relative mx-auto mt-5 max-w-2xl text-pretty text-base leading-7 text-white sm:text-lg">
          Entre no <span translate="no">{systemName}</span> e passe a abrir cada serviço sabendo quantas mesas estão
          comprometidas, quanto você pode perder e onde dá para ajustar.
        </p>
        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild className="h-12 rounded-full bg-[#211a15] px-6 text-base text-white hover:bg-[#382c24]">
            <Link to="/login">
              Acessar o painel
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="h-12 rounded-full px-6 text-base text-white hover:bg-white/10 hover:text-white"
          >
            <a href="#beneficios">Ver o que muda na casa</a>
          </Button>
        </div>
        <p className="relative mt-5 text-xs text-white">O acesso ao painel é para restaurantes já cadastrados.</p>
      </div>
    </section>
  );
}

function Footer({ systemName, systemLogo }: { systemName: string; systemLogo: string }) {
  return (
    <footer className="border-t border-[#2c241d]/10">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-5 px-5 py-9 text-center sm:flex-row sm:justify-between sm:px-8 sm:text-left">
        <a href="#topo" className="flex items-center gap-2.5" aria-label={'Voltar ao início de ' + systemName}>
          <BrandMark systemName={systemName} systemLogo={systemLogo} size="sm" />
          <span translate="no" className="text-sm font-semibold text-[#2d241e]">{systemName}</span>
        </a>
        <p className="text-xs text-[#786c63]">
          © {new Date().getFullYear()} {systemName}. Reservas sob controle, do pedido ao relatório.
        </p>
        <Link
          to="/login"
          className="text-xs font-semibold text-[#665b53] transition-colors duration-150 hover:text-[#a9572d]"
        >
          Entrar no painel
        </Link>
      </div>
    </footer>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-[#f8f4ec] text-[#211a15] selection:bg-[#efc5a8] selection:text-[#211a15]">
      {children}
    </div>
  );
}

function upsertLandingMeta(attribute: 'name' | 'property', key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }

  element.content = content;
}

function useLandingMetadata(systemName: string, systemLogoUrl: string) {
  useEffect(() => {
    const title = systemName + ' | Sistema de Reservas';
    const description =
      'Reserva descomplicada, controle das perdas e relatórios com a ocupação real da casa. Abra cada noite sabendo o que esperar do salão.';
    const canonicalUrl = `${window.location.origin}/`;
    const shareImage = systemLogoUrl
      ? new URL(systemLogoUrl, window.location.origin).toString()
      : null;
    const updates = [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', title],
      ['meta[property="og:description"]', description],
      ['meta[property="og:site_name"]', systemName],
      ['meta[name="twitter:title"]', title],
      ['meta[name="twitter:description"]', description],
    ] as const;
    const previousTitle = document.title;
    const previousValues = updates.map(([selector]) => document.querySelector(selector)?.getAttribute('content') ?? null);

    document.title = title;
    updates.forEach(([selector, content]) => document.querySelector(selector)?.setAttribute('content', content));

    // A LP não declarava endereço próprio: sem isso o Google trata cada variação de URL
    // (com utm, com barra final) como página distinta.
    upsertLandingMeta('property', 'og:url', canonicalUrl);
    upsertLandingMeta('property', 'og:locale', 'pt_BR');
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const createdCanonical = !canonical;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    const previousCanonical = canonical.href;
    canonical.href = canonicalUrl;

    if (shareImage) {
      upsertLandingMeta('property', 'og:image', shareImage);
      upsertLandingMeta('property', 'og:image:secure_url', shareImage);
      upsertLandingMeta('property', 'og:image:alt', systemName);
      upsertLandingMeta('name', 'twitter:image', shareImage);
      upsertLandingMeta('name', 'twitter:card', 'summary_large_image');
    }

    return () => {
      document.title = previousTitle;
      updates.forEach(([selector], index) => {
        const element = document.querySelector(selector);
        const previousValue = previousValues[index];
        if (element && previousValue !== null) element.setAttribute('content', previousValue);
      });

      if (createdCanonical) {
        canonical?.remove();
      } else if (canonical) {
        canonical.href = previousCanonical;
      }
    };
  }, [systemLogoUrl, systemName]);
}

export default function Home() {
  const { data: systemBranding } = useSystemBranding();
  const systemName = systemBranding?.system_name || DEFAULT_SYSTEM_NAME;
  const systemLogo = systemBranding?.system_logo_url || '';
  useFaviconOverride(systemLogo);
  useLandingMetadata(systemName, systemLogo);

  return (
    <PageShell>
      <a
        href="#conteudo-principal"
        className="sr-only z-[100] rounded-md bg-[#211a15] px-4 py-3 text-sm font-semibold text-white focus:fixed focus:left-4 focus:top-4 focus:not-sr-only"
      >
        Pular para o conteúdo
      </a>
      <NavBar systemName={systemName} systemLogo={systemLogo} />
      <main id="conteudo-principal">
        <Hero systemName={systemName} />
        <OutcomeStrip />
        <ProblemSection />
        <RoutineSection />
        <BenefitsSection />
        <ResultsSection />
        <ExtraBenefitsSection />
        <FaqSection />
        <ClosingCta systemName={systemName} />
      </main>
      <Footer systemName={systemName} systemLogo={systemLogo} />
    </PageShell>
  );
}
