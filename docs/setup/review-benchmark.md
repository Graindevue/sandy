# Configurer le login CI réservé aux benchmarks

Les tests réels de l'issue #4 s'exécutent dans le dépôt **privé**
`Graindevue/graindevue`, avec l'environnement **`sandy-codex-test`**.
Le secret **`CODEX_AUTH_JSON`** de cet environnement contient une nouvelle
session Codex, distincte de celle de production dans `sandy-codex`.
`Graindevue/sandy` héberge le code et les tests sans credentials ; ce dépôt
public ne doit pas héberger ce login.

## Ce que tu dois faire pour stocker les tokens

Depuis le checkout Sandy contenant cette modification, lance :

```bash
bash scripts/setup-review-benchmark.sh
```

L'assistant vérifie l'environnement privé, ouvre la page GitHub, puis lance
Codex **0.162.0** avec un dossier temporaire et un stockage de credentials en
fichier. Connecte-toi dans le navigateur au compte ChatGPT qui dispose de
Codex. Il s'agit d'une nouvelle session réservée aux tests CI ; elle peut
appartenir au même compte que tes autres sessions.

L'assistant valide le fichier sans afficher les tokens et l'envoie directement
à GitHub avec :

```bash
gh secret set CODEX_AUTH_JSON --repo Graindevue/graindevue \
  --env sandy-codex-test < "$SANDY_TEST_LOGIN_DIR/auth.json"
```

Cette dernière commande est exécutée par l'assistant. Il supprime ensuite le
dossier local sans lancer `codex logout`, qui pourrait invalider la session
transférée. Ne copie pas `auth.json` dans le chat, un ticket ou un commit.
Pour remplacer ce login plus tard, attends la fin des benchmarks et suspends
les nouveaux lancements pendant le transfert.

## Workflow et renouvellement automatique

Le [workflow de benchmark](../../.github/workflow-templates/sandy-benchmark.yml)
doit être installé dans `.github/workflows/sandy-benchmark.yml` du dépôt privé.
La variable de dépôt **`SANDY_BENCHMARK_REF`** désigne le SHA complet d'un commit
Sandy revu, indépendamment du pin de production `SANDY_REF`.

Les secrets de dépôt existants **`SANDY_APP_ID`** et
**`SANDY_APP_PRIVATE_KEY`** permettent à la GitHub App de réécrire le secret
de l'environnement. L'installation doit accorder **Environments: read & write**.
Le workflow demande cette permission avant d'utiliser le login et obtient un
nouveau token d'installation avant la sauvegarde, après les mesures.
Aucun PAT supplémentaire ni token OpenAI API n'est nécessaire.

Le job prend le verrou `sandy-codex-test-session`, puis lit le secret de
l'environnement. Un seul runtime utilise le fichier pendant chaque Review.
Avant les Agents du premier échantillon parallèle, le runtime demande le
renouvellement natif via `account/read` avec `refreshToken: true`. Le harness
observe le fichier sans modifier ses tokens ni `last_refresh`, puis vérifie
une rotation persistée pour le même compte. Un ancien `last_refresh` ne suffit
pas à forcer une rotation si le JWT d'accès reste valide. Aucun appel manuel au
point d'entrée OAuth n'est effectué. Les résultats n'enregistrent qu'un booléen
indiquant le renouvellement observé.

Après succès, erreur ou timeout de la commande, le workflow sauvegarde le
fichier mis à jour dans **le même environnement de test**, puis supprime les
credentials locaux. Une erreur de sauvegarde fait échouer le job. Seuls les
résultats, Findings et mesures bornés sont publiés dans l'artifact ; le login
et la clé de l'App en sont exclus.

## Lancer les mesures

Une fois le workflow présent sur la branche par défaut et le pin revu configuré,
ouvre **Actions → Sandy isolated benchmark → Run workflow**. Choisis la branche
par défaut, une répétition et les deux cas pour le premier lancement.
Le workflow refuse les reruns ; demande un nouveau lancement manuel.

Les fixtures et les reviewers sont fixes. Le harness compare les installations
froides et chaudes en série et en parallèle, sans commentaires de PR ni écritures
Convex. Le budget total est de 60 minutes, avec une marge pour sauvegarder le
login. Les mesures partielles sont conservées si ce budget expire.

Un premier lancement valide le dispositif. La promotion requiert plusieurs
comparaisons appariées et une adjudication humaine des Findings, selon le
[rapport de rollout](../benchmarks/review-speed.md). **Le mode série reste le
réglage par défaut** tant que tous ces critères ne sont pas remplis.

La procédure de login et de renouvellement suit la
[documentation officielle Codex](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
