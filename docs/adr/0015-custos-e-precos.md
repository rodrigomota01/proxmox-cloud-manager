# ADR-0015 — Custos: preço por recurso alocado, acúmulo por hora e relatórios por cliente

**Status:** Aceito · **Data:** 2026-10-07

## Contexto
A operação quer saber quanto cada cliente custa (agora, no mês e na previsão de
fechamento) e mostrar esse custo ao próprio cliente: uma prévia no dashboard, o
detalhe por projeto/instância e uma estimativa antes de criar uma VM. Não há billing
externo ainda; a arquitetura precisa deixar a integração possível depois.

## Decisão
- **Preço pelo que é alocado, não pelo consumo medido.** vCPU, GiB de RAM e GiB de
  disco configurados na VM, mais uma taxa fixa opcional por instância. CPU% e memória
  usada oscilam a cada sync e dependem do guest agent; alocação é o que o cliente
  contratou e o que a quota já controla.
- **Regra de cobrança:** vCPU e RAM só com a instância **ligada**; disco e taxa por
  instância enquanto ela **existe** (`active`/`deleting`). Instâncias em
  `provisioning`/`error` não são cobradas.
- **Preço mensal de 730 h, cobrado por segundo.** Uma moeda para a plataforma
  (`CM_BILLING_CURRENCY`, padrão BRL); meses no fuso `CM_BILLING_TIMEZONE`
  (padrão America/Sao_Paulo). Dinheiro é `numeric(18,6)`/`Decimal` ponta a ponta e
  string no JSON — nunca float.
- **Tabelas de preço versionadas** (`price_tables` + `price_items` com
  `effective_from`): mudar um preço insere um item novo, válido a partir de agora;
  nada é editado. Uma tabela é a padrão; o cliente pode ter a sua
  (`tenants.price_table_id`, só via `/admin`, `billing:manage`).
- **Acúmulo no worker** logo após o sync (a cada `CM_BILLING_INTERVAL_SECONDS`, 60 s):
  cobra o intervalo desde `billing_cursor` com o estado que o reconciliador acabou de
  ver, dividido nas horas UTC, uma linha por instância por hora em `usage_records`
  (segundos, segundos ligada e custo por recurso). Advisory lock + cursor e linhas na
  mesma transação: um intervalo nunca é cobrado duas vezes, nem some numa falha.
  O custo é gravado com o preço da hora; troca de preço/tabela vale daí em diante.
- **Worker parado:** até `CM_BILLING_MAX_GAP_SECONDS` (1 h) o intervalo é cobrado com
  o estado atual; acima disso o excedente não é cobrado (os estados no período são
  desconhecidos; erra-se a favor do cliente) e um aviso vai para o log.
- **Relatórios**: acumulado no mês (soma de `usage_records`), **custo atual** (as
  instâncias vivas com os preços de hoje, em R$/mês e R$/hora) e **previsão** (mês
  corrente: acumulado + custo atual até o fim do mês). Quebra por recurso, projeto,
  instância e dia; CSV gerado no frontend.
- **Visibilidade**: `usage_records` com RLS (o cliente lê as suas; só o worker, em
  escopo de plataforma, escreve). `billing:view` no tenant vê tudo do cliente; no
  projeto (PROJECT_ADMIN), só os projetos dele. Qualquer membro lê os preços vigentes
  do próprio cliente (`/billing/prices`), para a estimativa no formulário de criação.
  Admin da plataforma vê o custo por cliente (`/admin/billing/summary`) e o detalhe de
  um cliente entrando no tenant, como nas outras telas.

## Alternativas
- **Calcular sob demanda a partir da auditoria/jobs** (ligou às X, desligou às Y):
  perde o que muda fora da plataforma (VM desligada pelo Proxmox, resize manual).
  O sync já observa o estado real; amostrar dele é mais fiel.
- **Amostras horárias simples** (uma foto por hora): uma VM ligada 50 min e desligada
  na hora da foto sairia de graça. Intervalos contínuos entre syncs não têm esse buraco.
- **Preço por consumo medido**: mais justo em tese, mas instável e dependente do
  guest agent; fica para um tipo de item futuro se for pedido.

## Consequências
- `usage_records` cresce ~730 linhas por instância por mês; consolidação mensal ou
  particionamento entram junto com o de `audit_logs` (Fase 5).
- Discos e placas adicionais ainda não são cobrados (só o disco raiz observado).
- Exportar para um billing externo = ler `usage_records` (ou um resumo mensal) com o
  `price_table_id` de cada linha; o cálculo já está feito.
