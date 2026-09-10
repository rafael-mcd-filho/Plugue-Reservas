interface Props {
  active: boolean;
  loading: boolean;
  error: boolean;
  usesReview: boolean | null;
  official?: boolean;
}

/** Availability comes from Avaliações; template usage is a separate contract. */
export default function PostVisitReviewAvailability({ active, loading, error, usesReview, official = false }: Props) {
  if (loading) {
    return <p role="status" className="text-xs text-muted-foreground">Verificando a disponibilidade das avaliações…</p>;
  }
  if (error) {
    return (
      <p role="alert" className="text-xs leading-relaxed text-warning">
        Não foi possível consultar o estado das avaliações. A variável ficará indisponível até a consulta funcionar.
        {' '}{official && usesReview === null
          ? 'O envio do template antigo permanece no formato anterior até escolher e salvar uma opção.'
          : 'Mensagens sem avaliação continuam; novos envios que dependem dela não são enfileirados sem essa confirmação.'}
      </p>
    );
  }
  if (active) {
    return <p className="text-xs text-muted-foreground">Avaliações ativadas. Usar a variável no pós-visita é opcional.</p>;
  }
  if (usesReview === true) {
    return (
      <p role="alert" className="text-xs leading-relaxed text-warning">
        Este {official ? 'template' : 'modelo'} utiliza avaliação, mas as avaliações estão desativadas.
        {' '}Novos envios deste pós-visita não serão feitos até ativar as avaliações ou {official
          ? 'selecionar um template sem avaliação e informar que ele não utiliza a variável.'
          : 'retirar a variável e o convite de avaliação do texto.'}
      </p>
    );
  }
  if (usesReview === null) {
    return (
      <p role="alert" className="text-xs leading-relaxed text-warning">
        Avaliações desativadas e formato deste template ainda não revisado. O envio antigo está preservado.
        {' '}Para adotar o novo formato, confira as variáveis do template e salve a opção correspondente. Não alteramos seu template automaticamente.
      </p>
    );
  }
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      Avaliações desativadas. Ative na tela Avaliações para disponibilizar a variável. O pós-visita sem avaliação continua funcionando.
    </p>
  );
}
