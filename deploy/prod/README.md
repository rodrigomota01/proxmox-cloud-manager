# Produção numa VM (docker-compose-prod.yaml)

Imagens vêm do Artifact Registry (`us-central1-docker.pkg.dev/atena-cloud/acloud`), geradas
pelo workflow `images` a cada push na `main` (tag `sha-<commit>`) e em tags `v*`. Na VM rodam
Traefik (HTTPS), frontend, API, worker, Redis e PostgreSQL (volume `pgdata`).

## Pré-requisitos

- Docker Engine com Compose v2.23 ou mais novo (o script das roles do banco vai inline no compose).
- DNS do `CM_DOMAIN` apontando para a VM; portas 80 e 443 abertas da internet (o Let's Encrypt
  valida pela 80).
- Saída da VM para: API dos Proxmox (8006), API dos clusters Kubernetes (6443), SMTP (587)
  e o registry.
- Na VM bastam dois arquivos, num diretório só de root (ex.: `/opt/cloud-manager`):
  `docker-compose-prod.yaml` e `.env.prod` (modo 600).

## 1. Login no registry (uma vez)

```bash
cat chave-sa.b64 | docker login -u _json_key_base64 --password-stdin https://us-central1-docker.pkg.dev
```

## 2. Configuração

```bash
cp .env.prod.example .env.prod && chmod 600 .env.prod   # preencha tudo
docker run --rm us-central1-docker.pkg.dev/atena-cloud/acloud/cloud-manager-backend:<tag> \
  python -m app.cli gen-keys     # cole CM_JWT_PRIVATE_KEY e CM_KEK no .env.prod
```

Guarde o `.env.prod` num cofre. Sem a `CM_KEK`, as credenciais dos Proxmox e os kubeconfigs
salvos no banco não podem ser lidos; o backup do banco sozinho não basta.

As roles `cm_owner` e `cm_app` são criadas pelo init do PostgreSQL na primeira subida, com as
senhas do `.env.prod`.

## 3. Subir

```bash
# sem estar no grupo docker, prefixe com sudo (o login no registry também: sudo docker login)
alias dcp='docker compose -f docker-compose-prod.yaml --env-file .env.prod'
dcp pull
dcp up -d                       # postgres, migrate (roda e termina), depois api e worker
dcp run --rm migrate python -m app.cli create-admin --email voce@atena.io --name "Seu Nome"
dcp run --rm migrate python -m app.cli send-test-email --to voce@atena.io
```

## Atualizar

Faça um backup, troque `CM_IMAGE_TAG` no `.env.prod` pelo `sha-<commit>` novo e rode
`dcp pull && dcp up -d`. As migrations rodam sozinhas antes da API. Para voltar, use a tag
anterior; uma migration já aplicada não é desfeita, então restaure o backup se a versão nova
mudou o schema.

## Backup

Dump lógico, consistente com o banco no ar (formato custom, comprimido):

```bash
dcp exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > cloudmanager-$(date +%F-%H%M).dump
```

Para a rotina no S3, rode isso pelo cron e envie o arquivo (`aws s3 cp`). O dump não contém a
`CM_KEK` nem a `CM_JWT_PRIVATE_KEY`: o `.env.prod` precisa de cópia separada.

Restaurar num volume novo (pare api e worker antes):

```bash
dcp stop api worker
dcp exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < cloudmanager-AAAA-MM-DD-HHMM.dump
dcp up -d
```

## Logs

```bash
dcp logs -f api worker
```

Cada container guarda até 5 arquivos de 20 MB.
