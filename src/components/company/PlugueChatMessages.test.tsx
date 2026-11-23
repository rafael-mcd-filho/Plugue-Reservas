import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlugueChatMessages from './PlugueChatMessages';
import type { PlugueChatTemplate } from '@/hooks/usePlugueChatConfig';
import { PLUGUECHAT_AUTOMATIONS } from '@/lib/pluguechat-automations';

const { templatesMock, mutateMock, npsActivationMock, mutationState } = vi.hoisted(() => ({
  templatesMock: vi.fn(),
  mutateMock: vi.fn(),
  npsActivationMock: vi.fn(),
  mutationState: { isPending: false },
}));

vi.mock('@/hooks/usePlugueChatConfig', () => ({
  usePlugueChatTemplates: (...args: unknown[]) => templatesMock(...args),
  useUpsertPlugueChatTemplate: () => ({ mutate: mutateMock, ...mutationState }),
}));

vi.mock('@/hooks/useCompanyNpsActivation', () => ({
  useCompanyNpsActivation: (...args: unknown[]) => npsActivationMock(...args),
}));

const companyId = 'company-1';

function makeTemplate(mode: boolean | null): PlugueChatTemplate {
  return {
    id: 'post-visit-template-1',
    company_id: companyId,
    type: 'post_visit',
    enabled: false,
    template_id: 'post_visit_existing',
    template_name: 'Existing post-visit',
    post_visit_include_review_link: mode,
    created_at: '2026-09-09T12:00:00.000Z',
    updated_at: '2026-09-09T12:00:00.000Z',
  };
}

function renderWithTemplates(templates: PlugueChatTemplate[] = []) {
  templatesMock.mockReturnValue({ data: templates, isLoading: false });
  return render(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
}

function getCard(label = 'Pós-visita') {
  const card = screen.getByRole('heading', { name: label }).closest('.bg-card');
  if (!(card instanceof HTMLElement)) throw new Error(`Missing automation card: ${label}`);
  return within(card);
}

function getReviewRadios() {
  return {
    withReview: screen.getByRole('radio', { name: /^Sim — inclui o código/ }),
    withoutReview: screen.getByRole('radio', { name: /^Não — somente nome e data/ }),
  };
}

function editReference(label = 'Pós-visita') {
  const input = getCard(label).getByLabelText('Nome do template (referência)');
  fireEvent.change(input, { target: { value: `${(input as HTMLInputElement).value} revisado` } });
}

function expectSavedPayload(payload: unknown) {
  expect(mutateMock.mock.lastCall?.[0]).toEqual(payload);
}

describe('PlugueChatMessages post-visit review contract', () => {
  beforeEach(() => {
    templatesMock.mockReset();
    mutateMock.mockReset();
    npsActivationMock.mockReset();
    mutationState.isPending = false;
    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
  });

  afterEach(cleanup);

  it.each([null, undefined])('keeps an existing unknown contract unselected instead of guessing: %s', (mode) => {
    const template = makeTemplate(null);
    if (mode === undefined) delete template.post_visit_include_review_link;
    renderWithTemplates([template]);

    const { withReview, withoutReview } = getReviewRadios();
    expect(withReview).toHaveAttribute('aria-checked', 'false');
    expect(withoutReview).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Configuração antiga não revisada');
    expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();

    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload(expect.objectContaining({
      type: 'post_visit',
      post_visit_include_review_link: null,
    }));
  });

  it('defaults a new template to name/date while showing the centrally available review variable', () => {
    renderWithTemplates();

    expect(getReviewRadios().withoutReview).toHaveAttribute('aria-checked', 'true');
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'false');
    expect(getCard().getByText('nome', { exact: true })).toBeInTheDocument();
    expect(getCard().getByText('data', { exact: true })).toBeInTheDocument();
    expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.change(getCard().getByLabelText('Template ID'), { target: { value: 'post_visit_name_date' } });
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload({
      company_id: companyId,
      type: 'post_visit',
      enabled: false,
      template_id: 'post_visit_name_date',
      template_name: null,
      post_visit_include_review_link: false,
    });
  });

  it('hydrates a configured template without evaluation and saves its explicit false value', () => {
    renderWithTemplates([makeTemplate(false)]);

    expect(getReviewRadios().withoutReview).toHaveAttribute('aria-checked', 'true');
    expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload(expect.objectContaining({
      template_id: 'post_visit_existing',
      post_visit_include_review_link: false,
    }));
  });

  it.each([true, false])('saves the chosen review contract together with its matching template ID: %s', (includeReview) => {
    renderWithTemplates([makeTemplate(!includeReview)]);
    const nextId = includeReview ? 'post_visit_with_review' : 'post_visit_without_review';
    const { withReview, withoutReview } = getReviewRadios();

    fireEvent.click(includeReview ? withReview : withoutReview);
    fireEvent.change(getCard().getByLabelText('Template ID'), { target: { value: nextId } });
    expect(mutateMock).not.toHaveBeenCalled();
    if (includeReview) {
      expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
      expect(getCard().getByText(/esta mensagem não será enviada com campo vazio/)).toBeInTheDocument();
    } else {
      expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
    }

    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload({
      company_id: companyId,
      type: 'post_visit',
      enabled: false,
      template_id: nextId,
      template_name: 'Existing post-visit',
      post_visit_include_review_link: includeReview,
    });
  });

  it.each([null, false, true])('preserves the saved review mode when activation is toggled: %s', (mode) => {
    renderWithTemplates([makeTemplate(mode)]);

    const toggle = screen.getByRole('switch', { name: 'Ativar Pós-visita' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload({
      company_id: companyId,
      type: 'post_visit',
      enabled: true,
      template_id: 'post_visit_existing',
      template_name: 'Existing post-visit',
      post_visit_include_review_link: mode,
    });
  });

  it('keeps activation and template drafts after a failed save, allowing retry or discard', () => {
    renderWithTemplates([makeTemplate(true)]);
    const toggle = screen.getByRole('switch', { name: 'Ativar Pós-visita' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));

    const callbacks = mutateMock.mock.calls[0][1] as { onError: () => void };
    act(() => callbacks.onError());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'true');
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
    expect(getCard().getByRole('alert')).toHaveTextContent('Suas alterações foram mantidas');
    fireEvent.click(getCard().getByRole('button', { name: 'Tentar salvar novamente' }));
    expect(mutateMock).toHaveBeenCalledTimes(2);
    fireEvent.click(getCard().getByRole('button', { name: 'Descartar' }));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
  });

  it.each(PLUGUECHAT_AUTOMATIONS.filter((automation) => automation.type !== 'post_visit'))(
    'does not add the post-visit option when saving or activating $type',
    (automation) => {
      renderWithTemplates();
      const card = getCard(automation.label);
      fireEvent.change(card.getByLabelText('Template ID'), { target: { value: 'another_template' } });
      fireEvent.click(card.getByRole('button', { name: 'Salvar' }));
      fireEvent.click(screen.getByRole('switch', { name: `Ativar ${automation.label}` }));
      fireEvent.click(card.getByRole('button', { name: 'Salvar' }));

      expect(mutateMock).toHaveBeenCalledTimes(2);
      for (const [payload] of mutateMock.mock.calls) {
        expect(payload).toMatchObject({ type: automation.type, template_id: 'another_template' });
        expect(payload).not.toHaveProperty('post_visit_include_review_link');
      }
    },
  );

  it('explains the official token-only format and the non-official complete URL', () => {
    renderWithTemplates([makeTemplate(true)]);

    expect(getCard().getByText(/no PlugueChat, avaliacao recebe apenas o código após/))
      .toHaveTextContent('O endereço completo até /avaliacao/ deve estar no template aprovado, com o slug da sua empresa.');
    expect(getCard().getByText(/Na API não oficial, a variável continua recebendo o link completo/))
      .toBeInTheDocument();
  });

  it('keeps name/date templates usable and hides all review UI when reviews are disabled', () => {
    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderWithTemplates([makeTemplate(false)]);

    expect(npsActivationMock).toHaveBeenCalledWith(companyId);
    expect(getCard().queryByText('avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().getByText('nome', { exact: true })).toBeInTheDocument();
    expect(getCard().getByText('data', { exact: true })).toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByRole('radio')).not.toBeInTheDocument();
    expect(getCard().queryByText('Este template utiliza a variável de avaliação?')).not.toBeInTheDocument();
    expect(getCard().queryByText(/No PlugueChat|Na API não oficial/)).not.toBeInTheDocument();
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativar Pós-visita' })).not.toBeDisabled();
    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload(expect.objectContaining({
      template_id: 'post_visit_existing',
      post_visit_include_review_link: false,
    }));
  });

  it.each([true, null])('hides review UI when disabled without rewriting the saved contract: %s', (mode) => {
    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderWithTemplates([makeTemplate(mode)]);

    expect(getCard().queryByText('avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByRole('status')).not.toBeInTheDocument();
    expect(getCard().queryByRole('radio')).not.toBeInTheDocument();
    expect(getCard().queryByText('Este template utiliza a variável de avaliação?')).not.toBeInTheDocument();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
    expect(mutateMock).not.toHaveBeenCalled();

    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload(expect.objectContaining({
      template_id: 'post_visit_existing',
      post_visit_include_review_link: mode,
    }));
  });

  it.each([
    { label: 'loading', isPending: true, isError: false },
    { label: 'failed refresh', isPending: false, isError: true },
  ])('hides all review UI while availability is $label, even with cached enabled state', ({ isPending, isError }) => {
    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending, isError });
    renderWithTemplates([makeTemplate(false)]);

    expect(getCard().queryByText('avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByRole('status')).not.toBeInTheDocument();
    expect(getCard().queryByRole('radio')).not.toBeInTheDocument();
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('hides review UI and preserves the legacy contract when availability cannot be read', () => {
    npsActivationMock.mockReturnValue({ data: undefined, isPending: false, isError: true });
    renderWithTemplates([makeTemplate(null)]);
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByRole('status')).not.toBeInTheDocument();
    expect(getCard().queryByRole('radio')).not.toBeInTheDocument();
    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expectSavedPayload(expect.objectContaining({ post_visit_include_review_link: null }));
  });

  it('updates availability across activation changes without saving, replacing IDs, or resetting a draft', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    fireEvent.click(getReviewRadios().withReview);
    fireEvent.change(getCard().getByLabelText('Template ID'), { target: { value: 'unsaved_review_template' } });
    fireEvent.change(getCard().getByLabelText('Nome do template (referência)'), { target: { value: 'Unsaved draft' } });

    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().queryByText('avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByRole('radio')).not.toBeInTheDocument();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('unsaved_review_template');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Unsaved draft');
    expect(mutateMock).not.toHaveBeenCalled();

    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByText('avaliacao', { exact: true })).toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'true');
    expect(getReviewRadios().withReview).not.toBeDisabled();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('unsaved_review_template');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Unsaved draft');
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('saves activation, IDs, reference and review format in a single operation, then clears dirty state', () => {
    const onUnsavedChange = vi.fn();
    templatesMock.mockReturnValue({ data: [makeTemplate(false)], isLoading: false });
    render(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" onUnsavedChange={onUnsavedChange} />);
    const card = getCard();
    expect(card.getByRole('button', { name: 'Salvar' })).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: 'Ativar Pós-visita' }));
    fireEvent.change(card.getByLabelText('Template ID'), { target: { value: 'review_approved' } });
    fireEvent.change(card.getByLabelText('Nome do template (referência)'), { target: { value: 'Reviewed' } });
    fireEvent.click(getReviewRadios().withReview);
    expect(mutateMock).not.toHaveBeenCalled();
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(card.getByRole('button', { name: 'Salvar' }));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expectSavedPayload({ company_id: companyId, type: 'post_visit', enabled: true, template_id: 'review_approved', template_name: 'Reviewed', post_visit_include_review_link: true });
    act(() => mutateMock.mock.lastCall?.[1].onSuccess());
    expect(card.queryByText('Alterações não salvas')).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  });

  it('discards only the chosen card and never persists draft edits', () => {
    renderWithTemplates([makeTemplate(false)]);
    editReference();
    const otherCard = getCard('Confirmação de Reserva');
    fireEvent.change(otherCard.getByLabelText('Template ID'), { target: { value: 'confirmation_draft' } });
    fireEvent.click(getCard().getByRole('button', { name: 'Descartar' }));
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Existing post-visit');
    expect(otherCard.getByLabelText('Template ID')).toHaveValue('confirmation_draft');
    expect(otherCard.getByText('Alterações não salvas')).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('merges untouched server fields during refresh while preserving local edits', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    editReference();
    templatesMock.mockReturnValue({ data: [{ ...makeTemplate(false), enabled: true, template_id: 'new_server_id', template_name: 'Updated on server' }], isLoading: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Existing post-visit revisado');
    expect(getCard().getByLabelText('Template ID')).toHaveValue('new_server_id');
    expect(screen.getByRole('switch', { name: 'Ativar Pós-visita' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(getCard().getByRole('button', { name: 'Descartar' }));
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Updated on server');
  });

  it('isolates drafts and old mutation callbacks when the selected company changes', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    editReference();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    const oldCallbacks = mutateMock.mock.lastCall?.[1];
    templatesMock.mockReturnValue({ data: [{ ...makeTemplate(true), company_id: 'company-2', template_id: 'second_company_id' }], isLoading: false });
    rerender(<PlugueChatMessages companyId="company-2" activeChannel="pluguechat_official" />);
    act(() => oldCallbacks.onError());
    act(() => oldCallbacks.onSuccess());
    expect(getCard().getByLabelText('Template ID')).toHaveValue('second_company_id');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Existing post-visit');
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getCard().queryByText('Alterações não salvas')).not.toBeInTheDocument();
  });

  it('shows query failures instead of an empty editable configuration and supports retry', () => {
    const refetch = vi.fn();
    templatesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar os templates');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('does not initialize editable drafts from cached templates after a failed initial read', () => {
    templatesMock.mockReturnValue({ data: [makeTemplate(false)], isLoading: false, isError: true, refetch: vi.fn() });
    const { rerender } = render(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Tente novamente para editar com segurança');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Template ID')).not.toBeInTheDocument();
    templatesMock.mockReturnValue({ data: [makeTemplate(false)], isLoading: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('preserves drafts and prevents writes until a failed refresh is retried', () => {
    const templates = [makeTemplate(false)];
    const { rerender } = renderWithTemplates(templates);
    editReference();
    templatesMock.mockReturnValue({ data: templates, isLoading: false, isError: true, refetch: vi.fn() });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Suas alterações foram mantidas');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Existing post-visit revisado');
    expect(getCard().getByLabelText('Template ID')).toBeDisabled();
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    templatesMock.mockReturnValue({ data: templates, isLoading: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
  });

  it('blocks editing while a save is pending', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    editReference();
    mutationState.isPending = true;
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByLabelText('Template ID')).toBeDisabled();
    expect(getCard().getByLabelText('Nome do template (referência)')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativar Pós-visita' })).toBeDisabled();
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(getCard().getByRole('button', { name: 'Descartar' })).toBeDisabled();
  });

  it('retains drafts but prevents saving when the active channel cannot be verified', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    editReference();
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" saveBlocked />);
    expect(getCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Existing post-visit revisado');
    expect(getCard().getByRole('button', { name: 'Descartar' })).not.toBeDisabled();
    expect(mutateMock).not.toHaveBeenCalled();
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
  });

  it('previews only fictitious parameters for the selected official template format', () => {
    renderWithTemplates([makeTemplate(false)]);
    const details = getCard().getByText('Prévia dos parâmetros').closest('details');
    expect(details).not.toHaveAttribute('open');
    if (!(details instanceof HTMLElement)) throw new Error('Missing preview');
    const preview = within(details);
    expect(preview.getByText(/O texto final é o template aprovado na Meta/)).toBeInTheDocument();
    expect(preview.getByText('Maria')).toBeInTheDocument();
    expect(preview.queryByText('avaliacao:')).not.toBeInTheDocument();
    fireEvent.click(getReviewRadios().withReview);
    expect(preview.getByText('avaliacao:')).toBeInTheDocument();
    expect(preview.getByText('DEMONSTRACAO')).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it.each([
    { mode: null, available: true, value: 'https://exemplo.invalid/avaliacao/DEMONSTRACAO' },
    { mode: null, available: false, value: '"" (vazio)' },
    { mode: true, available: true, value: 'DEMONSTRACAO' },
    { mode: true, available: false, value: '"" (vazio)' },
  ])('previews the actual review parameter contract: mode=$mode available=$available', ({ mode, available, value }) => {
    npsActivationMock.mockReturnValue({ data: { enabled: available }, isPending: false, isError: false });
    renderWithTemplates([makeTemplate(mode)]);
    const details = getCard().getByText('Prévia dos parâmetros').closest('details');
    if (!(details instanceof HTMLElement)) throw new Error('Missing preview');
    const preview = within(details);
    expect(preview.getByText('avaliacao:').nextElementSibling).toHaveTextContent(value);
    if (mode === null) expect(preview.getByText(/Formato antigo preservado/)).toBeInTheDocument();
    if (mode === true && !available) expect(preview.getByText(/não tem envio elegível/)).toBeInTheDocument();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
    expect(getCard().queryByText('Alterações não salvas')).not.toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it.each([
    { isPending: true, isError: false },
    { isPending: false, isError: true },
  ])('does not preview a token as available when review availability is unknown: %s', ({ isPending, isError }) => {
    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending, isError });
    renderWithTemplates([makeTemplate(true)]);
    const details = getCard().getByText('Prévia dos parâmetros').closest('details');
    if (!(details instanceof HTMLElement)) throw new Error('Missing preview');
    const preview = within(details);
    expect(preview.getByText(/não tem envio elegível/)).toBeInTheDocument();
    expect(preview.getByText('avaliacao:').nextElementSibling).toHaveTextContent('"" (vazio)');
    expect(preview.queryByText('DEMONSTRACAO')).not.toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
