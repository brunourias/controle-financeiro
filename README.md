# Fluxo — Controle Financeiro

Aplicativo web responsivo para importar faturas de cartão e extratos bancários em PDF, acompanhar gastos e comparar a evolução financeira mês a mês.

## Recursos disponíveis

- leitura real de múltiplos PDFs de fatura e extrato;
- identificação automática do mês de cada documento;
- detecção de documentos repetidos por hash SHA-256;
- revisão das transações antes da importação;
- visão mensal, comparação e evolução por categoria;
- login com Google e histórico salvo no Cloud Firestore;
- experiência instalável no celular (PWA).

Os PDFs são processados no navegador. O Firebase recebe somente os dados extraídos e confirmados pelo usuário, não os arquivos originais.

## Ativar o Firebase

1. Crie um projeto exclusivo no [Firebase Console](https://console.firebase.google.com/) e registre um aplicativo Web.
2. Em **Authentication > Sign-in method**, ative o provedor Google.
3. Em **Authentication > Settings > Authorized domains**, adicione `brunourias.github.io`.
4. Crie um banco **Cloud Firestore** e publique as regras do arquivo `firestore.rules`.
5. No repositório GitHub, abra **Settings > Secrets and variables > Actions** e crie estes Repository secrets com os valores de configuração do aplicativo Web:

   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`

6. Execute novamente o workflow **Publicar no GitHub Pages**.

> A configuração do aplicativo Firebase fica exposta no JavaScript publicado por definição. A proteção dos dados depende da autenticação e das regras do Firestore; não substitua as regras por acesso público.

## Desenvolvimento local

Copie `.env.example` para `.env.local`, preencha os valores e execute:

```bash
npm install
npm run dev
```

## Privacidade

Não envie faturas, extratos, senhas, tokens, chaves administrativas ou arquivos `.env` ao repositório.
