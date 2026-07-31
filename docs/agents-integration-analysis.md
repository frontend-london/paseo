# Analiza integracyjna: Paseo jako programowalna warstwa sesji/runtime dla Delivery Managera

**Repozytorium:** `~/projects/paseo` (`getpaseo/paseo`)  
**Cel:** Ocenić, czy Paseo może pełnić rolę programowalnej warstwy sterowania sesjami i runtime'em agentów kodujących używaną przez *Agents delivery manager* (Hermes/Agents).  
**Zakres:** Wyłącznie analiza istniejącego kodu Paseo — bez wprowadzania zmian ani implementacji integracji.

---

## 1. Executive summary

Paseo **może** zostać użyte jako programowalna warstwa kontroli sesji i runtime'u dla Delivery Managera, pod warunkiem że DM łączy się z daemonem Paseo tak jak każdy inny klient — przez **WebSocket RPC**. Nie ma natywnego HTTP/SSE ani webhooków; cała komunikacja jest kanałem WebSocket z korelatorem `requestId`.

Daemon Paseo uruchamia lokalnie procesy agentów (Claude Code, Codex, OpenCode, Copilot przez ACP, Pi itp.) i eksponuje jednolite API do:

- tworzenia, listowania, anulowania, archiwizowania i usuwania agentów (`create_agent_request`, `fetch_agents_request`, `cancel_agent_request`, `archive_agent_request`, `delete_agent_request`);
- wysyłania kolejnych promptów do istniejącej sesji (`send_agent_message_request`);
- oczekiwania na zakończenie tury (`wait_for_finish_request`);
- zmiany modelu, trybu, opcji reasoning i feature'ów w trakcie życia agenta (`set_agent_model_request`, `set_agent_mode_request`, `set_agent_thinking_request`, `set_agent_feature_request`);
- odczytu timeline/agenta (`fetch_agent_request`, `fetch_agent_timeline_request`);
- odpowiadania na uprawnienia (`agent_permission_response`).

Kluczowe źródło prawdy protokołu to <ref_file file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" />, a implementację sesji i dispatchowania zdarzeń znajduje się w <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/session.ts" /> oraz <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-manager.ts" />.

**Podsumowanie decyzyjne:**

- **Tak** — Paseo nadaje się jako runtime layer.
- DM musi być **klientem WebSocket** (lub opakowaniem CLI, które i tak idzie przez WebSocket).
- Nie ma webhooków — sterowanie event-driven wymaga utrzymywania trwałego połączenia i nasłuchiwania `agent_stream` / `agent_update`.
- Model/mode/reasoning są sterowalne, ale per provider i z różnym semantycznym opóźnieniem (często dopiero następna tura).
- Dla maszyn zdalnych Paseo musi działać na docelowej maszynie; DM łączy się przez TCP/UNIX socket lub relay Paseo, a nie "uruchamia agenta zdalnie".

---

## 2. Tabela zdarzeń użytecznych dla Delivery Managera

Zdarzenia docierają do klienta jako komunikaty `SessionOutboundMessage` (patrz <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" lines="4547-4646" />). Dla agentów najważniejsze są `agent_update` oraz `agent_stream`.

| Zdarzenie (WebSocket) | Payload | Kiedy występuje | Co DM może z niego wyczytać |
|---|---|---|---|
| `agent_update` (kind `upsert`) | `AgentSnapshotPayload` | Przy każdej zmianie stanu agenta | `status`, `currentModeId`, `availableModes`, `model`, `requiresAttention`, `attentionReason`, `lastError`, `runtimeInfo`, `pendingPermissions` <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" lines="686-714" /> |
| `agent_update` (kind `remove`) | `agentId` | Agent usunięty | Usunięcie z lokalnego stanu DM |
| `agent_stream` → `thread_started` | `sessionId`, `provider` | Nowa sesja providera została uruchomiona | Potwierdzenie startu sesji |
| `agent_stream` → `turn_started` | `provider` | Agent zaczął turę (reakcję na prompt) | Początek generowania odpowiedzi |
| `agent_stream` → `turn_completed` | `provider`, opcjonalnie `usage` | Tura zakończona sukcesem | Koniec odpowiedzi; należy sprawdzić `attentionReason`/`status` |
| `agent_stream` → `turn_failed` | `provider`, `error`, `code`, `diagnostic` | Tura zakończona błędem | Błąd wykonania; DM może zareagować eskalacją |
| `agent_stream` → `turn_canceled` | `provider`, `reason` | Tura przerwana (cancel, interrupt, wymiana promptu) | Agent przestał pracować; `reason` wyjaśnia dlaczego |
| `agent_stream` → `timeline` | `item` (wiadomość asystenta, narzędzie, reasoning, itp.) | Streamingowa zawartość tury | Pełna treść odpowiedzi/progress; `item.type` rozróżnia rodzaje <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" lines="605-666" /> |
| `agent_stream` → `permission_requested` | `request` | Agent prosi o zgodę | Należy odpowiedzieć `agent_permission_response` lub użyć trybu unattended |
| `agent_stream` → `permission_resolved` | `requestId`, `resolution` | Uprawnienie rozstrzygnięte | Potwierdzenie dla DM |
| `agent_stream` → `attention_required` | `reason: finished\|error\|permission`, `shouldNotify`, `notification` | Agent przeszedł z `running` w stan wymagający uwagi | **Główne zdarzenie do sterowania kolejnym krokiem pipeline'u** <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/websocket-server.ts" lines="1952-2015" /> |
| `wait_for_finish_response` | `status`, `final`, `lastMessage`, `error` | Odpowiedź na `wait_for_finish_request` | Wygodna, blokująca/event-driven alternatywa dla ręcznego nasłuchiwania zdarzeń <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/session.ts" lines="5897-6016" /> |
| `status` → `agent_created` / `agent_create_failed` | `agent` lub `error` | Odpowiedź na `create_agent_request` | Potwierdzenie utworzenia agenta |

### Mapowanie pytań biznesowych na zdarzenia

- **Początek odpowiedzi:** `turn_started` + `agent_update` ze `status: "running"`.
- **Koniec odpowiedzi:** `turn_completed` (lub `attention_required` z `reason: finished`) + `agent_update` ze `status: "idle"`.
- **Agent czeka na input:** `permission_requested` lub `attention_required` z `reason: "permission"`.
- **Zadanie zrobione:** `attention_required` z `reason: "finished"` oraz `agent_update` z `requiresAttention: true`, `attentionReason: "finished"`.
- **Błąd:** `turn_failed` / `attention_required` z `reason: "error"` / `agent_update` ze `status: "error"`.
- **Przerwane/rozłączone:** `turn_canceled` lub `status: "error"`.

---

## 3. Tabela akcji sterujących (WebSocket RPC)

Wszystkie poniższe komunikaty to elementy `SessionInboundMessage` zdefiniowane w <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" lines="2207-2346" />. Referencyjną implementacją klienta jest <ref_file file="/home/piotr/projects/paseo/packages/client/src/daemon-client.ts" />, która pokazuje dokładne pola wysyłane do daemona.

| Akcja | Komunikat | Kluczowe pola | Odpowiedź / efekt |
|---|---|---|---|
| Utwórz agenta | `create_agent_request` | `config` (provider, cwd, model, modeId, thinkingOptionId, initialPrompt, workspaceId, env, labels, outputSchema, images, attachments, git, worktree, autoArchive, ...) | `status: agent_created` + `AgentSnapshotPayload`; agent przechodzi `initializing → idle → running` <ref_snippet file="/home/piotr/projects/paseo/packages/client/src/daemon-client.ts" lines="2236-2286" /> |
| Wyślij kolejny prompt | `send_agent_message_request` | `agentId`, `text`, `messageId`, `images`, `attachments` | `send_agent_message_response` (`accepted`); jeśli agent był zajęty, `replaceRunning: true` powoduje przerwanie poprzedniej tury <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/session.ts" lines="5793-5895" /> |
| Oczekuj na zakończenie | `wait_for_finish_request` | `agentId`, `timeoutMs` | `wait_for_finish_response` (`status: idle\|error\|permission\|timeout`, `final`, `lastMessage`) <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-manager.ts" lines="2391-2550" /> |
| Lista agentów | `fetch_agents_request` | `filter` | `fetch_agents_response` z listą `AgentSnapshotPayload` |
| Pobierz agenta | `fetch_agent_request` | `agentId` | `fetch_agent_response` z aktualnym snapshotem |
| Timeline agenta | `fetch_agent_timeline_request` | `agentId`, `direction`, `limit`, `projection` | `fetch_agent_timeline_response` (pełna historia wiadomości/narzędzi) |
| Anuluj/Interrupted | `cancel_agent_request` | `agentId` | `cancel_agent_response`; przerywa trwającą turę |
| Archiwizuj agenta | `archive_agent_request` | `agentId` | `agent_archived` |
| Usuń agenta | `delete_agent_request` | `agentId` | `agent_deleted` |
| Wznów agenta | `resume_agent_request` | `agentId` | `agent_resumed` |
| Zmień model | `set_agent_model_request` | `agentId`, `modelId` | `set_agent_model_response` (`accepted`); w większości providerów działa od następnej tury, jeśli tura trwa <ref_snippet file="/home/piotr/projects/paseo/packages/client/src/daemon-client.ts" lines="2846-2871" /> |
| Zmień tryb | `set_agent_mode_request` | `agentId`, `modeId` | `set_agent_mode_response` (`accepted`, opcjonalnie `notice`); tryby zależą od providera |
| Zmień reasoning | `set_agent_thinking_request` | `agentId`, `thinkingOptionId` | `set_agent_thinking_response` (`accepted`, `notice`); często "applies next turn" |
| Zmień feature | `set_agent_feature_request` | `agentId`, `featureId`, `value` | `set_agent_feature_response`; np. `fast_mode` dla Claude/Codex |
| Odepnij agenta (detach) | `agent.detach.request` | `agentId` | `agent.detach.response` |
| Cofnij (rewind) | `agent.rewind.request` | `agentId`, `messageId`, `mode` | `agent.rewind.response` |
| Odpowiedź na uprawnienie | `agent_permission_response` | `agentId`, `requestId`, `response` (`behavior: allow\|deny`, ...) | `permission_resolved` stream + kolejna tura, jeśli wymagana |
| Wyczyść attention | `clear_agent_attention` | `agentId` | `clear_agent_attention_response` |
| Lista providerów | `list_available_providers_request` | — | lista built-in + custom ACP |
| Lista modeli/mode'ów providera | `list_provider_models_request` / `list_provider_modes_request` | `provider` | katalog z `models`, `modes`, `thinkingOptions` |
| Utwórz workspace | `workspace.create.request` | `source: { kind: "directory"\|"worktree", ... }` | `workspace.create.response` (`workspace` z `id`, `workspaceDirectory`) <ref_snippet file="/home/piotr/projects/paseo/packages/cli/src/commands/agent/run.ts" lines="440-465" /> |

### Uwagi do akcji

- `send_agent_message_request` **nie wymaga kolejkowania ani pollingu** — daemon sam serializuje tury i zarządza `activeForegroundTurnId`.
- `wait_for_finish_request` nie jest busy-pollingiem; wewnętrznie subskrybuje `agent_state`/`agent_stream` aż do terminalnego zdarzenia <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-manager.ts" lines="2505-2548" />.
- Aby odpowiedzieć na `permission_requested`, DM wysyła `agent_permission_response` z `behavior: "allow"` lub `"deny"` <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/session.ts" lines="3235-3264" />.

---

## 4. Cykl życia agenta (lifecycle)

Stan agenta jest reprezentowany przez `AgentStatusSchema` / `AgentLifecycleStatus` i zawiera się w `AgentSnapshotPayload.status`.

```
initializing
    │
    ▼
  idle  ◄────────────┐
    │                │
    │  prompt / run  │
    ▼                │
 running             │
    │                │
    ├─► turn_completed / attention_required(finished)
    │                │
    ▼                │
  idle  ─────────────┘
    │
    ├─► error  (attention_required(error))
    │
    ├─► permission (attention_required(permission) / permission_requested)
    │
    └─► closed (po delete/close)
```

- `initializing` — daemon tworzy provider session i uruchamia proces agenta.
- `idle` — agent gotowy do przyjęcia promptu lub zakończył poprzednią turę.
- `running` — trwa tura (forefront turn).
- `error` — ostatnia tura zakończyła się błędem; `lastError` w snapshotie zawiera szczegóły.
- Stan `attention` (`requiresAttention`, `attentionReason`) jest **edge-triggered**: pojawia się raz przy przejściu `running → idle` (finished) lub wejściu w `error`/`permission`, aż do `clear_agent_attention` <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-manager.ts" lines="3665-3703" />.
- Cykl życia jest opisany szczegółowo w <ref_file file="/home/piotr/projects/paseo/packages/protocol/src/agent-lifecycle.ts" /> i <ref_file file="/home/piotr/projects/paseo/docs/agent-lifecycle.md" />.

---

## 5. Automatyczny przepływ reakcji na zdarzenia

Delivery Manager może działać w pełni event-driven bez pollingu:

1. **Subskrypcja** do `agent_stream` i `agent_update` po nawiązaniu WebSocketu.
2. **Uruchomienie pierwszego agenta** (np. Coder): `create_agent_request` z `initialPrompt`, `provider`, `cwd`, opcjonalnie `workspaceId`, `model`, `modeId`, `thinkingOptionId`, `outputSchema`.
3. **Oczekiwanie na zakończenie**: DM może użyć `wait_for_finish_request` (blokujący/event-driven na tym samym połączeniu) lub nasłuchiwać `attention_required` z `reason: "finished"`.
4. **Odczyt wyniku**:
   - `wait_for_finish_response.lastMessage` zawiera ostatnią wiadomość asystenta;
   - jeśli potrzebna pełna treść, `fetch_agent_timeline_request` z `direction: "tail"` i `limit`.
5. **Decyzja DM**:
   - **Kontynuacja tej samej sesji:** `send_agent_message_request` z kolejnym promptem.
   - **Uruchomienie kolejnego agenta:** `create_agent_request` dla Testera/Reviewera, z nowym `workspaceId` lub tym samym (współdzielenie workspace'u). Wynik z poprzedniego agenta można przekazać jako `initialPrompt`.
   - **Eskalacja:** jeśli `reason: "error"` lub `status: "error"`, DM może odtworzyć agenta (`create_agent_request`) lub użyć `agent.rewind.request`.
6. **Uprawnienia:** w trybach unattended (np. `bypassPermissions`, `full-access`, `allow-all`) DM nie musi nic robić. W trybach wymagających zgody DM odpowiada `agent_permission_response` na `permission_requested`.

### Przykład: Coder → Tester → Reviewer

```
DM ─create_agent_request (provider=codex, mode=full-access, outputSchema=test-plan-schema)
   ◄agent_update (status=running)
   ◄agent_stream turn_started
   ◄agent_stream ... timeline ...
   ◄agent_stream turn_completed
   ◄agent_stream attention_required(reason=finished)
   ◄agent_update requiresAttention=true, attentionReason=finished
DM ─fetch_agent_timeline_request (direction=tail, limit=50)
   ◄timeline z wiadomością asystenta
DM ─create_agent_request (provider=claude, mode=default,
                          initialPrompt="<wynik Coder> wykonaj testy...")
   ...analogicznie...
DM ─create_agent_request (provider=claude, mode=plan,
                          initialPrompt="<wynik Testera> przejrzyj zmiany...")
```

Klient CLI Paseo robi dokładnie to samo: `client.createAgent(...)` → `client.waitForFinish(...)` → ew. `client.sendMessage(...)` <ref_snippet file="/home/piotr/projects/paseo/packages/cli/src/commands/agent/run.ts" lines="508-600" />.

---

## 6. Macierz sterowania modelem / reasoning / trybem per provider

Providerzy dzielą się na **natywnych** (własna implementacja w `packages/server`) i **ACP** (Agent Client Protocol — generyczny lub dedykowane wrappery `cursor-acp-agent.ts`, `kiro-acp-agent.ts`, `trae-acp-agent.ts`, `copilot-acp-agent.ts`, `generic-acp-agent.ts`).

| Provider | Rodzaj | Zmiana modelu w runtime | Dostępne tryby | Zmiana trybu w runtime | Opcje reasoning / thinking | Uwagi |
|---|---|---|---|---|---|---|
| **Claude** | natywny | `set_agent_model_request` — aktualizuje `activeQuery` w providerze; jeśli trwa tura, może mieć efekt od następnej tury | `plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions` <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/claude/agent.ts" lines="282-310" /> | `set_agent_mode_request` | `low`, `medium`, `high`, `xhigh`, `max` (effort levels); `fast_mode` jako feature | Bogate sterowanie, MCP, rewind, `fast_mode` zależy od modelu <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/claude/model-manifest.ts" /> |
| **Codex** | natywny | `set_agent_model_request` — `this.config.model`; sprawdza `codexModelSupportsFastMode` | `auto`, `auto-review`, `full-access` (+ wewnętrzny `read-only`) <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts" lines="202-219" /> | `set_agent_mode_request`; aktywna tura daje notice "applies next turn" | Opcje `thinking` mapowane na `thinkingOptionId`; `fast_mode` jako feature | Tryb `full-access` = `isUnattended`, sieć dozwolona <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts" lines="253-272" /> |
| **OpenCode** | natywny | `set_agent_model_request` — `providerId/modelId`, np. `byteplus-openai/glm-5.1` | `build`, `plan` (legacy `full-access` mapuje na `build` + `auto_accept=true`) <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/opencode-agent.ts" lines="135-146" /> | `set_agent_mode_request` | `set_agent_thinking_request` ustawia `config.thinkingOptionId` przekazywany jako `effectiveVariant` do OpenCode | Wieloproviderowy; modele pochodzą z wewnętrznego katalogu OpenCode <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/opencode-agent.ts" lines="2952-2967" /> |
| **Pi** | natywny | `set_agent_model_request` — wymaga `provider/model`, woła `runtimeSession.setModel` | Brak (setMode rzuca błąd) | — | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/pi/agent.ts" lines="144-156" /> | Minimalny terminalowy agent; model w formacie `provider/id` |
| **OMP** | natywny | Tak (dzieli kod z Pi, inne domyślne `providerParams` / command) | Brak | — | Tak (Pi options) | Alias Pi z innym bianrym (`omp`) |
| **Copilot** | ACP (`copilot-acp-agent.ts`) | `set_agent_model_request` — przez ACP `setSessionConfigOption` lub `unstable_setSessionModel` | `https://agentclientprotocol.com/protocol/session-modes#agent`, `#plan`, `allow-all` <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/provider-manifest.ts" lines="103-126" /> | `set_agent_mode_request` | `set_agent_thinking_request` przez ACP `setSessionConfigOption` kategorii `thought_level` | `allow-all` = `isUnattended` |
| **Cursor** | ACP (`cursor-acp-agent.ts`) | Tak (dziedziczy `ACPAgentClient.setModel`) | Zależne od ACP | Tak | Tak | Dodatkowy feature `fast` |
| **Kiro / Trae** | ACP (`kiro-acp-agent.ts`, `trae-acp-agent.ts`) | Tak | Zależne od ACP | Tak | Tak | Czekają na inicjalne komendy (<10 s) |
| **Generic ACP** (`devin`, `grok`, `factory-droid`, `gemini`, `goose`, `cline` itd.) | konfigurowany przez `agents.providers.<id>` z `extends: "acp"` i `command: [...]` | Tak, jeśli dany CLI ACP eksponuje model switching | Zależne od ACP | Tak, jeśli ACP provider je eksponuje | Tak, jeśli ACP ma opcję `thought_level` | Wymaga ręcznej rejestracji w konfiguracji Paseo <ref_snippet file="/home/piotr/projects/paseo/packages/protocol/src/provider-config.ts" lines="46-111" /> |

### Ogólne zasady model/mode/reasoning

- Dla wszystkich providerów zmiany modelu/mode'u/reasoningu w trakcie trwającej tury są zazwyczaj **odroczone do następnej tury** (notice `SETTING_APPLIES_NEXT_TURN_NOTICE` widać w <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/claude/agent.ts" lines="96-98" /> i <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts" lines="3941-3967" />).
- Providerzy ACP delegują te operacje do `ACPAgentClient.setModel` / `setMode` / `setThinkingOption`, które próbują `unstable_setSessionModel` lub `setSessionConfigOption` <ref_snippet file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/acp-agent.ts" lines="1612-1886" />.
- **Devin CLI, Grok, Factory Droid** nie są natywnie zarejestrowane w daemonie jako built-in. Są dostępne przez ACP catalog w aplikacji (<ref_file file="/home/piotr/projects/paseo/public-docs/supported-providers.md" />) i wymagają wpisu w konfiguracji `paseo.json`:
  ```json
  {
    "agents": {
      "providers": {
        "devin": {
          "extends": "acp",
          "label": "Devin CLI",
          "command": ["devin", "acp"]
        }
      }
    }
  }
  ```
  <ref_snippet file="/home/piotr/projects/paseo/packages/app/src/data/acp-provider-catalog.ts" lines="131-137" />.

---

## 7. Propozycja integracji i rekomendacja

### 7.1. Zalecana architektura

```
┌─────────────────────────────────────┐
│      Delivery Manager (Hermes)     │
│  ┌───────────────────────────────┐│
│  │  Paseo WebSocket Client       ││
│  │  - utrzymuje 1 połączenie     ││
│  │  - subskrybuje agent_* events ││
│  │  - emituje create/send/wait   ││
│  └───────────────────────────────┘│
└────────────┬────────────────────────┘
             │ WebSocket (tcp/unix/pipe/relay)
┌────────────▼────────────────────────┐
│        Paseo daemon               │
│  - zarządza agentami (procesy)    │
│  - persistuje snapshoty            │
│  - broadcastuje zdarzenia          │
└────────────┬────────────────────────┘
             │ lokalne procesy agentów
┌────────────▼────────────────────────┐
│  Claude / Codex / OpenCode / Pi    │
│  Copilot / Cursor / ACP providers  │
└─────────────────────────────────────┘
```

### 7.2. Krok po kroku — najprostszy PoC

1. **Wybierz sposób połączenia:**
   - Lokalnie: unix socket (`unix:///path/paseo.sock`) lub `ws://localhost:6767/ws`.
   - Zdalnie: relay Paseo, TCP z hasłem, lub SSH port-forward do socketu.
2. **Nawiąż połączenie WebSocket** i zacznij nasłuchiwać `agent_update` oraz `agent_stream`.
3. **Utwórz workspace** (`workspace.create.request`) lub użyj `cwd` jako workspace root.
4. **Utwórz agenta Coder** (`create_agent_request`) z promptem i `outputSchema` (jeśli chcesz uporządkowany wynik).
5. **Zaczekaj na `wait_for_finish_response`** lub na `attention_required` z `reason: finished`.
6. **Pobierz ostatnią wiadomość** (`lastMessage` z `wait_for_finish_response` lub `fetch_agent_timeline_request`).
7. **Utwórz agenta Tester** z promptem zawierającym wynik Coder; użyj tego samego `workspaceId`, jeśli ma operować na tym samym kodzie.
8. **Powtórz** dla Reviewera.
9. **Obsługuj błędy:**
   - `turn_failed` / `attention_required(error)` → log, powiadom operatora lub restartuj z nowym promptem.
   - `permission_requested` → odpowiedz `agent_permission_response` albo upewnij się, że wybrano tryb unattended.

### 7.3. Uwagi praktyczne i ograniczenia

- **Brak webhooków/SSE:** DM musi być ciągle połączony lub mieć własny reconnect logic.
- **Paseo jest lokalny per maszyna:** agent processes działają na maszynie, na której stoi daemon. Aby uruchomić agenta na zdalnej maszynie, należy uruchomić tam Paseo i połączyć się z nim (relay/TCP/socket).
- **Środowisko i cwd:** `env` i `cwd` ustawia się tylko w `create_agent_request`. Nie ma RPC do dynamicznej zmiany środowiska istniejącego agenta (można użyć worktree przy tworzeniu, <ref_snippet file="/home/piotr/projects/paseo/packages/cli/src/commands/agent/run.ts" lines="37-46" />).
- **Zmiany runtime'owe:** model/mode/reasoning zmieniane w trakcie tury często obowiązują od następnej tury.
- **Tryby unattended:** aby uniknąć ręcznej akceptacji każdego narzędzia, należy użyć `bypassPermissions` (Claude), `full-access` (Codex), `allow-all` (Copilot), `build` + `auto_accept=true` (OpenCode) lub analogicznego trybu ACP.
- **outputSchema:** dostępny w `create_agent_request`; pozwala uzyskać strukturyzowane wyjście, ale wymaga providera, który potrafi go zinterpretować.
- **Identyfikacja:** DM powinien tagować tworzonych agentów `labels` (np. `role: coder`, `ticket: AGT-123`) i używać `fetch_agents_request` do wyszukiwania.
- **Korelowanie requestów:** każdy request musi mieć unikalny `requestId`; odpowiedź zawiera ten sam `requestId`.

### 7.4. Ostateczna rekomendacja

**Rekomenduję użycie Paseo jako warstwy runtime'owej** dla Delivery Managera, z następującym podejściem:

1. **Pierwsza faza — PoC WebSocket:** napisz cienki adapter DM (Node/TS lub Python z `websockets`), który otwiera połączenie do Paseo, tworzy pipeline Coder → Tester → Reviewer i reaguje na `attention_required` oraz `wait_for_finish_response`.
2. **Druga faza — abstrakcja agenta:** wydziel klasę `PaseoAgentSession`, która ukrywa `createAgent` / `sendMessage` / `waitForFinish` / `fetchTimeline` i obsługuje `permission_requested` dla wybranych providerów.
3. **Trzecia faza — remote execution:** dla maszyn zdalnych uruchamiaj daemon Paseo na docelowej maszynie (np. przez Hermes `tools/remote`) i łącz DM przez relay/TCP.
4. **Zarządzanie ryzykiem:**
   - Przetestuj każdego providera osobno pod kątem `setModel` / `setMode` / `setThinkingOption` — szczególnie ACP.
   - Dla providerów ACP (Devin, Grok, Factory Droid) przygotuj konfigurację `extends: "acp"` i zweryfikuj, czy dany CLI obsługuje wymagane metody ACP.
   - Nie zakładaj, że `set_*_request` natychmiast zmienia zachowanie trwającej tury; zawsze czekaj na `turn_completed`.

Paseo ma kompletne API do orkiestracji agentów; główne wyzwanie to utrzymanie trwałego połączenia WebSocket i dopasowanie provider-specific model/mode/reasoning, a nie sam protokół.

---

## Odniesienia do kluczowych plików

- <ref_file file="/home/piotr/projects/paseo/packages/protocol/src/messages.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/session.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-manager.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/agent-sdk-types.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/provider-registry.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/claude/agent.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/opencode-agent.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/server/src/server/agent/providers/acp-agent.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/client/src/daemon-client.ts" />
- <ref_file file="/home/piotr/projects/paseo/packages/cli/src/commands/agent/run.ts" />
- <ref_file file="/home/piotr/projects/paseo/public-docs/supported-providers.md" />
- <ref_file file="/home/piotr/projects/paseo/packages/protocol/src/provider-config.ts" />
