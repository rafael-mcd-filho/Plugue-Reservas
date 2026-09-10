import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlugueChatMessages from './PlugueChatMessages';
import type { PlugueChatTemplate } from '@/hooks/usePlugueChatConfig';
import { PLUGUECHAT_AUTOMATIONS } from '@/lib/pluguechat-automations';

const { templatesMock, mutateMock, npsActivationMock } = vi.hoisted(() => ({
  templatesMock: vi.fn(),
  mutateMock: vi.fn(),
  npsActivationMock: vi.fn(),
}));

vi.mock('@/hooks/usePlugueChatConfig', () => ({
  usePlugueChatTemplates: (...args: unknown[]) => templatesMock(...args),
  useUpsertPlugueChatTemplate: () => ({ mutate: mutateMock, isPending: false }),
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

describe('PlugueChatMessages post-visit review contract', () => {
  beforeEach(() => {
    templatesMock.mockReset();
    mutateMock.mockReset();
    npsActivationMock.mockReset();
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
    expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();

    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.change(getCard().getByLabelText('Template ID'), { target: { value: 'post_visit_name_date' } });
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith({
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
    expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({
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
      expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
      expect(getCard().getByText(/esta mensagem não será enviada com campo vazio/)).toBeInTheDocument();
    } else {
      expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
    }

    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith({
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
    expect(mutateMock).toHaveBeenCalledWith({
      company_id: companyId,
      type: 'post_visit',
      enabled: true,
      template_id: 'post_visit_existing',
      template_name: 'Existing post-visit',
      post_visit_include_review_link: mode,
    }, expect.objectContaining({ onError: expect.any(Function) }));
  });

  it('restores activation after a failed save without changing the selected review contract', () => {
    renderWithTemplates([makeTemplate(true)]);
    const toggle = screen.getByRole('switch', { name: 'Ativar Pós-visita' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    const callbacks = mutateMock.mock.calls[0][1] as { onError: () => void };
    act(() => callbacks.onError());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'true');
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
  });

  it.each(PLUGUECHAT_AUTOMATIONS.filter((automation) => automation.type !== 'post_visit'))(
    'does not add the post-visit option when saving or activating $type',
    (automation) => {
      renderWithTemplates();
      const card = getCard(automation.label);
      fireEvent.change(card.getByLabelText('Template ID'), { target: { value: 'another_template' } });
      fireEvent.click(card.getByRole('button', { name: 'Salvar' }));
      fireEvent.click(screen.getByRole('switch', { name: `Ativar ${automation.label}` }));

      expect(mutateMock).toHaveBeenCalledTimes(2);
      for (const [payload] of mutateMock.mock.calls) {
        expect(payload).toMatchObject({ type: automation.type, template_id: 'another_template' });
        expect(payload).not.toHaveProperty('post_visit_include_review_link');
      }
    },
  );

  it('explains the official token-only format and the non-official complete URL', () => {
    renderWithTemplates([makeTemplate(true)]);

    expect(getCard().getByText(/no PlugueChat, link_avaliacao recebe apenas o código após/))
      .toHaveTextContent('O endereço completo até /avaliacao/ deve estar no template aprovado, com o slug da sua empresa.');
    expect(getCard().getByText(/Na API não oficial, a variável continua recebendo o link completo/))
      .toBeInTheDocument();
  });

  it('keeps name/date templates usable with reviews disabled and does not let users opt into review usage', () => {
    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderWithTemplates([makeTemplate(false)]);

    expect(npsActivationMock).toHaveBeenCalledWith(companyId);
    expect(getCard().queryByText('link_avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().getByText('nome', { exact: true })).toBeInTheDocument();
    expect(getCard().getByText('data', { exact: true })).toBeInTheDocument();
    expect(getCard().getByText(/O pós-visita sem avaliação continua funcionando/)).toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getReviewRadios().withReview).toBeDisabled();
    expect(getReviewRadios().withoutReview).not.toBeDisabled();
    fireEvent.click(getReviewRadios().withReview);
    expect(getReviewRadios().withoutReview).toHaveAttribute('aria-checked', 'true');
    expect(getCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativar Pós-visita' })).not.toBeDisabled();
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({
      template_id: 'post_visit_existing',
      post_visit_include_review_link: false,
    }));
  });

  it.each([true, null])('warns about disabled review dependencies without rewriting the saved contract: %s', (mode) => {
    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderWithTemplates([makeTemplate(mode)]);

    expect(getCard().queryByText('link_avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().getByRole('alert')).toHaveTextContent(mode === true
      ? 'Este template utiliza avaliação, mas as avaliações estão desativadas'
      : 'Avaliações desativadas e formato deste template ainda não revisado');
    if (mode === null) {
      expect(getCard().getByRole('alert')).toHaveTextContent('O envio antigo está preservado');
      expect(getCard().getByRole('status')).toHaveTextContent('até escolher e salvar');
    }
    expect(getCard().getByLabelText('Template ID')).toHaveValue('post_visit_existing');
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', mode === true ? 'true' : 'false');
    expect(getReviewRadios().withoutReview).toHaveAttribute('aria-checked', 'false');
    expect(getReviewRadios().withReview).toBeDisabled();
    expect(mutateMock).not.toHaveBeenCalled();

    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({
      template_id: 'post_visit_existing',
      post_visit_include_review_link: mode,
    }));
  });

  it.each([
    { label: 'loading', isPending: true, isError: false, role: 'status', message: 'Verificando a disponibilidade' },
    { label: 'failed refresh', isPending: false, isError: true, role: 'alert', message: 'Não foi possível consultar' },
  ])('withholds the review variable while availability is $label, even with cached enabled state', ({ isPending, isError, role, message }) => {
    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending, isError });
    renderWithTemplates([makeTemplate(false)]);

    expect(getCard().queryByText('link_avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().getByRole(role)).toHaveTextContent(message);
    expect(getReviewRadios().withReview).toBeDisabled();
    expect(getReviewRadios().withoutReview).toHaveAttribute('aria-checked', 'true');
    expect(getCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('preserves the legacy contract even when review availability cannot be read', () => {
    npsActivationMock.mockReturnValue({ data: undefined, isPending: false, isError: true });
    renderWithTemplates([makeTemplate(null)]);
    expect(getCard().getByRole('alert')).toHaveTextContent('O envio do template antigo permanece no formato anterior');
    expect(getCard().getByRole('alert')).not.toHaveTextContent('não são enfileirados');
    fireEvent.click(getCard().getByRole('button', { name: 'Salvar' }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({ post_visit_include_review_link: null }));
  });

  it('updates availability across activation changes without saving, replacing IDs, or resetting a draft', () => {
    const { rerender } = renderWithTemplates([makeTemplate(false)]);
    fireEvent.click(getReviewRadios().withReview);
    fireEvent.change(getCard().getByLabelText('Template ID'), { target: { value: 'unsaved_review_template' } });
    fireEvent.change(getCard().getByLabelText('Nome do template (referência)'), { target: { value: 'Unsaved draft' } });

    npsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().queryByText('link_avaliacao', { exact: true })).not.toBeInTheDocument();
    expect(getCard().getByRole('alert')).toHaveTextContent('as avaliações estão desativadas');
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'true');
    expect(getReviewRadios().withReview).toBeDisabled();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('unsaved_review_template');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Unsaved draft');
    expect(mutateMock).not.toHaveBeenCalled();

    npsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
    rerender(<PlugueChatMessages companyId={companyId} activeChannel="pluguechat_official" />);
    expect(getCard().getByText('link_avaliacao', { exact: true })).toBeInTheDocument();
    expect(getCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getReviewRadios().withReview).toHaveAttribute('aria-checked', 'true');
    expect(getReviewRadios().withReview).not.toBeDisabled();
    expect(getCard().getByLabelText('Template ID')).toHaveValue('unsaved_review_template');
    expect(getCard().getByLabelText('Nome do template (referência)')).toHaveValue('Unsaved draft');
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
