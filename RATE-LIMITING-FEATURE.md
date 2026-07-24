# Rate Limiting Feature — Detailed Summary

> Document destiné à la review. Décrit l'implémentation complète de la fonctionnalité de limitation de débit (RPM + backoff 429) dans OpenFox.

## 1. Contexte et Objectif

### Problème

OpenFox est un assistant de codage agentic qui envoie des requêtes LLM en rafale. Lorsqu'on utilise un provider avec une limite stricte (ex: **40 RPM**), on obtient des erreurs **HTTP 429 Too Many Requests** qui interrompent le travail de l'agent.

### État initial (avant cette feature)

- ❌ **Aucune gestion du 429** : `http-client.ts` lançait une `LLMError` brute sur toute erreur HTTP, sans distinguer le 429 ni lire le header `Retry-After`.
- ❌ **Aucun rate limiting proactif** : aucune notion de RPM côté client.
- ✅ Un système de retry existait (`retry-limiter.ts` + `auto-patterns.ts`) mais **uniquement basé sur le contenu** (regex sur la réponse), pas sur les erreurs HTTP.
- ✅ Un helper `withRetry` (backoff) existait dans `async.ts` mais n'était **pas utilisé** par le client LLM.

### Solution choisie : approche hybride

Après analyse concurrentielle (Claude Code, Cursor, Cline, Roo Code, Kilo Code) et discussion avec l'utilisateur, approche **hybride** retenue :

1. **Rate limiter proactif (token bucket)** : évite les erreurs à la source en espaçant les requêtes.
2. **Backoff exponentiel réactif sur 429** : filet de sécurité avec jitter (anti-thundering-herd) et respect du header `Retry-After`.

Cette approche est **plus complète que tous les concurrents** :

- Roo Code a le backoff mais pas le rate limiter proactif → erreurs quand même.
- Kilo Code a un intervalle mais ne contrôle pas les bursts parallèles → erreurs quand même.
- Cursor/Claude Code : rien de configurable.

---

## 2. Architecture

### Flux de données

```
┌─────────────────────────────────────────────────────────────┐
│  AdvancedTab.tsx (UI)                                        │
│    └─ RateLimitEditor.tsx → settings store → DB (settings)   │
└──────────────────────────┬──────────────────────────────────┘
                           │ getRateLimitConfig()
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  orchestrator.ts → setupRateLimit()                          │
│    lit la config, crée le rateLimiter, appelle               │
│    llmClient.setRateLimit({ rateLimiter, retryOptions, cb }) │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  agent-loop.ts → streamLLMPure(messageId: assistantMsgId)    │
│    └─ stream-pure.ts → buildStreamRequest(messageId)         │
│         └─ client.ts → runWithRateLimit(messageId)           │
│              ├─ rateLimiter.acquire()  → onWaiting callback   │
│              └─ sur 429 → backoff + jitter → onRetry callback │
└──────────────────────────┬──────────────────────────────────┘
                           │ append(event)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  EventStore → apply-events.ts (attach au message)            │
│            → ws/protocol.ts → WS stream → frontend           │
│            → messageHandler.ts (fold sur message streaming)   │
│            → AssistantMessage.tsx → RateLimitBadge            │
└─────────────────────────────────────────────────────────────┘
```

### Streaming/fetch parity (principe OpenFox)

Les données streamées en temps réel sont **identiques en forme** à celles récupérées au reload :

- Pendant le streaming : `messageHandler.ts` attache l'événement à `message.rateLimitEvents`.
- Au reload : `apply-events.ts` + `fold-state.ts` reconstruisent `rateLimitEvents` depuis les événements persistés.
- Le rendu (`RateLimitBadge`) utilise le même code dans les deux cas.

---

## 3. Fichiers Créés

### `src/server/llm/rate-limiter.ts`

Token bucket avec fenêtre glissante de 60 secondes.

- Garde les timestamps des N dernières requêtes en mémoire.
- `acquire()` : bloque (await) jusqu'à ce qu'un slot se libère si la limite RPM est atteinte.
- Désactivé par défaut (`enabled: false`).
- Retourne `{ waitedMs, currentRpm }`.

```typescript
export interface RateLimiter {
  acquire(): Promise<AcquireResult>
  getCurrentRpm(): number
  getConfig(): RateLimiterConfig
}
```

### `src/server/llm/rate-limit-controller.ts`

Orchestrateur du rate limiting + retry 429.

- `runWithRateLimit(operation, controller)` : wrappe une opération.
- Appelle `rateLimiter.acquire()` avant l'opération.
- Sur `RateLimitError` : calcule le délai (`computeRetryDelay`), attend, réessaie.
- Invoque les callbacks `onWaiting` / `onRetry` avec le `messageId` associé.

### `src/server/llm/http-client.test.ts`

Tests de détection du 429 (mock de `proxyFetch`).

### `web/src/components/settings/RateLimitEditor.tsx`

Composant UI de configuration :

- Toggle "Enable RPM throttle"
- Input RPM (1–1000)
- Toggle "Retry on 429"
- Input Max retries (1–20)
- Input Initial backoff ms (100–60000)

---

## 4. Fichiers Modifiés

### Backend

| Fichier                                             | Modification                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/utils/errors.ts`                        | Ajout de `RateLimitError` (extends `LLMError`, porte `statusCode`, `retryAfterMs`, `attempt`) + `isRateLimitError()`.                                                                                                                         |
| `src/server/utils/async.ts`                         | Ajout de `computeExponentialBackoff` (2^n, cap 32s, jitter), `parseRetryAfter` (seconds + HTTP-date), `computeRetryDelay` (préfère Retry-After).                                                                                              |
| `src/server/llm/http-client.ts`                     | Détection du 429 : parse `Retry-After`, lance `RateLimitError` typée au lieu de `LLMError` générique.                                                                                                                                         |
| `src/server/llm/types.ts`                           | Ajout de `messageId?` à `LLMCompletionRequest` (pour l'attribution des événements).                                                                                                                                                           |
| `src/server/llm/client.ts`                          | Ajout de `setRateLimit()` + `RateLimitController`. Wrap des appels `complete()` et `stream()` avec `runWithRateLimit`. Passe `request.messageId` au controller.                                                                               |
| `src/server/llm/mock.ts`                            | Ajout de `setRateLimit: () => {}` (no-op pour le mock).                                                                                                                                                                                       |
| `src/server/providers/adapters/transport-client.ts` | Ajout de `setRateLimit: () => {}` (no-op).                                                                                                                                                                                                    |
| `src/server/db/settings.ts`                         | Ajout de `SETTINGS_KEYS.LLM_RATE_LIMIT`, `RateLimitConfig`, `RATE_LIMIT_DEFAULTS`, `getRateLimitConfig()` (validation + clamping + fallback sûr).                                                                                             |
| `src/server/chat/orchestrator.ts`                   | Ajout de `setupRateLimit()` : lit la config, configure le client, enregistre les callbacks qui `append()` les événements `rate_limit.waiting` / `rate_limit.retry`. Appelé avant `runTopLevelAgentLoop` (partagé par top-level + sub-agents). |
| `src/server/chat/stream-pure.ts`                    | Passe `messageId` à `buildStreamRequest`.                                                                                                                                                                                                     |
| `src/server/chat/stream-utils.ts`                   | `buildStreamRequestObject` accepte et propage `messageId`.                                                                                                                                                                                    |
| `src/server/events/types.ts`                        | Ajout des types d'événements `rate_limit.waiting` et `rate_limit.retry` + `RateLimitEntry`.                                                                                                                                                   |
| `src/server/events/session.ts`                      | Ajout de `emitRateLimitWaiting()` et `emitRateLimitRetry()`.                                                                                                                                                                                  |
| `src/server/events/apply-events.ts`                 | Handling des 2 événements : attache `rateLimitEvents` au message (par `messageId`).                                                                                                                                                           |
| `src/server/events/fold-state.ts`                   | Fold session-level de `rateLimitEvents`.                                                                                                                                                                                                      |
| `src/server/events/fold-types.ts`                   | Ajout de `rateLimitEvents?` à `FoldedSessionState`.                                                                                                                                                                                           |
| `src/server/ws/protocol.ts`                         | Ajout de `createChatRateLimitMessage()` + handling des 2 événements dans `storedEventToServerMessage`.                                                                                                                                        |
| `src/server/session/manager.ts`                     | Mapping `SnapshotMessage` → `Message` : propage `rateLimitEvents` et `formatRetries` (parity reload).                                                                                                                                         |
| `src/shared/protocol.ts`                            | Ajout du type `chat.rate_limit` + `ChatRateLimitPayload`.                                                                                                                                                                                     |
| `src/shared/types.ts`                               | Ajout de `rateLimitEvents?` et `formatRetries?` à l'interface `Message`.                                                                                                                                                                      |

### Frontend

| Fichier                                            | Modification                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `web/src/stores/settings.ts`                       | Ajout de `LLM_RATE_LIMIT` à `SETTINGS_KEYS`.                                                                   |
| `web/src/components/settings/tabs/AdvancedTab.tsx` | Ajout de la section "Rate Limiting" avec `RateLimitEditor`, chargement/sauvegarde via `useSettingsStoreState`. |
| `web/src/components/plan/AssistantMessage.tsx`     | Ajout du composant `RateLimitBadge` (rendu des événements waiting/retry avec icônes distinctes).               |
| `web/src/stores/session/messageHandler.ts`         | Case `chat.rate_limit` : fold les événements sur le message streaming (via `set()`), + logs console.           |

---

## 5. Critères d'Acceptation (11/11 remplis)

| #   | Critère                                                                                       | Statut                |
| --- | --------------------------------------------------------------------------------------------- | --------------------- |
| 0   | Module rate-limiter (token bucket, sliding 60s window, async acquire, tests)                  | ✅ 6 tests            |
| 1   | Backoff exponentiel + jitter + Retry-After dans async.ts (cap 32s, tests)                     | ✅ 8 tests            |
| 2   | Détection 429 + RateLimitError typée dans http-client.ts (tests)                              | ✅ 5 tests            |
| 3   | Intégration dans client.ts via runWithRateLimit (disabled-by-default préservé, tests)         | ✅ 6 tests            |
| 4   | SETTINGS_KEYS.LLM_RATE_LIMIT + getRateLimitConfig() (validation/clamping, tests)              | ✅ 6 tests            |
| 5   | Événements rate_limit.waiting/retry (types + emit + apply-events + ws/protocol, tests)        | ✅                    |
| 6   | Callback onRateLimit branché dans orchestrator (top-level + sub-agents, pattern.retry intact) | ✅                    |
| 7   | Composant RateLimitEditor.tsx (toggles + inputs + clamp, tests)                               | ✅ 5 tests            |
| 8   | Section "Rate Limiting" dans AdvancedTab.tsx                                                  | ✅                    |
| 9   | Rendu des événements dans le chat feed + streaming parity                                     | ✅ (corrigé, voir §6) |
| 10  | typecheck + lint + test:unit passent (pas de nouvelle régression)                             | ✅                    |

---

## 6. Bug Trouvé et Corrigé (Critère 9)

### Le problème (détecté par le vérificateur)

Au premier passage, le critère 9 était marqué complet mais **ne fonctionnait pas en utilisation réelle** :

1. **`messageId: ''`** : `setupRateLimit` enregistrait les callbacks avec un `messageId` vide (le `assistantMsgId` n'était pas accessible au moment de l'enregistrement).
2. **Reload cassé** : `apply-events.ts` faisait `messages.get('')` → `undefined` → événement silencieusement droppé.
3. **Streaming cassé** : `messageHandler.ts` ne faisait que `console.warn()`, n'attachait pas l'événement au message.
4. Le test `AssistantMessage.test.tsx` passait uniquement parce qu'il construisait manuellement un message avec `rateLimitEvents` pré-rempli.

### La correction

1. **Threading du vrai messageId** :
   - Ajout de `messageId?` à `LLMCompletionRequest`.
   - `streamLLMPure` (qui a `assistantMsgId`) → `buildStreamRequest` → client → `runWithRateLimit(controller.messageId)` → callbacks.
   - `setupRateLimit` utilise maintenant le `messageId` reçu dans les callbacks.

2. **Folding en streaming** : `messageHandler.ts` attache désormais les payloads `chat.rate_limit` au message via `set()` (comme `chat.tool_preparing`).

3. **Tests ajoutés** :
   - `rate-limit-controller.test.ts` : vérifie que `messageId` est transmis aux callbacks.
   - `session.test.ts` (2 tests) : vérifie l'attachement au message streaming + isolation par session.

---

## 7. Configuration et Valeurs par Défaut

```json
{
  "enabled": false,
  "rpm": 40,
  "retryOn429": true,
  "maxRetries": 5,
  "initialBackoffMs": 2000
}
```

- **Désactivé par défaut** : aucun impact sur les utilisateurs existants.
- **Cap du backoff** : 32 000ms par tentative (+ jitter 0–500ms).
- **Backoff exponentiel** avec `initialBackoffMs=2000` :
  - Tentative 1 : ~2000ms
  - Tentative 2 : ~4000ms
  - Tentative 3 : ~8000ms
  - Tentative 4 : ~16000ms
  - Tentative 5 : ~32000ms
  - **Total max : ~62s** (couvre une fenêtre RPM d'1 minute).

Clé settings : `llm.rateLimit` (JSON en DB).

---

## 8. Tests

### Tests serveur (nouveaux)

| Fichier                         | Tests | Description                                                                        |
| ------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `rate-limiter.test.ts`          | 6     | Fenêtre glissante, blocage/release, expiration, concurrence                        |
| `rate-limit-controller.test.ts` | 6     | Retry sur 429, backoff, épuisement, non-retry autres erreurs, messageId forwarding |
| `http-client.test.ts`           | 5     | Détection 429, parse Retry-After (seconds + HTTP-date), classification             |
| `async.test.ts`                 | +8    | computeExponentialBackoff, parseRetryAfter, computeRetryDelay                      |
| `errors.test.ts`                | +3    | RateLimitError, isRateLimitError, retryable                                        |
| `settings.test.ts`              | +6    | getRateLimitConfig (defaults, invalid, clamping)                                   |
| `folding.test.ts`               | +1    | rateLimitEvents sur message                                                        |
| `protocol.test.ts`              | +3    | createChatRateLimitMessage + storedEventToServerMessage                            |

### Tests frontend (nouveaux)

| Fichier                     | Tests | Description                                   |
| --------------------------- | ----- | --------------------------------------------- |
| `RateLimitEditor.test.tsx`  | 5     | Toggles, clamp RPM/retries/backoff            |
| `AssistantMessage.test.tsx` | +2    | Rendu badge waiting/retry, absence quand vide |
| `session.test.ts`           | +2    | Fold sur message streaming, isolation session |

### Résultats

- **245 tests** des zones modifiées : tous passent.
- **Typecheck** : ✓ (server + web).
- **Lint** : ✓ (aucune nouvelle erreur dans les fichiers modifiés).
- **Régressions** : 0. Les 33 échecs préexistants sont des problèmes Windows (symlinks, paths absolus, encoding) dans des fichiers **non touchés** par cette feature.

---

## 9. Points d'Attention pour la Review

1. **Disabled-by-default** : le rate limiter n'a aucun effet tant que l'utilisateur ne l'active pas dans Advanced settings. Le chemin par défaut utilise un controller no-op (`createRateLimiter({ enabled: false, rpm: 0 })`).

2. **Threading du messageId** : c'est le point le plus subtil. Le `assistantMsgId` est créé dans `agent-loop.ts` à chaque itération de boucle, mais `setupRateLimit` est appelé une fois avant la boucle. La solution : le messageId est porté par la **requête** (`LLMCompletionRequest.messageId`) et transmis au controller au moment de l'appel LLM, puis remonté aux callbacks.

3. **Double écriture évitée** : `setupRateLimit` utilise le closure `append` (chemin d'écriture unique vers l'EventStore) plutôt que les helpers `emitRateLimitWaiting/Retry` (qui écriraient en double).

4. **Parity streaming/reload** : vérifiée à deux endroits :
   - `messageHandler.ts` (live) attache à `message.rateLimitEvents`.
   - `manager.ts` (reload) propage `rateLimitEvents` depuis le snapshot.
   - Même champ, même rendu.

5. **Jitter** : `Math.random() * 500ms` ajouté à chaque backoff pour éviter le thundering herd (requêtes parallèles synchronisées).

6. **Respect du header `Retry-After`** : quand le provider le fournit (seconds ou HTTP-date), sa valeur est utilisée (clampée à 32s) au lieu du backoff calculé.
