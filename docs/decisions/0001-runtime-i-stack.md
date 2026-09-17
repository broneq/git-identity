# 0001 - Runtime, architektura i stack

- **Status:** przyjęte
- **Data:** 2026-09-17
- **Dotyczy:** git-identity oraz kolejnych pluginów Claude Code w tym ekosystemie

## Kontekst

Plugin ma wiązać projekt z kontem GitHuba i tożsamością git. Techniczne jądro
problemu to trzy zadania:

1. odczyt i zapis rejestru profili,
2. scalenie bloku `env` w `.claude/settings.local.json` użytkownika bez
   niszczenia jego pozostałych kluczy,
3. hook `SessionStart`, który porównuje stan pliku ze stanem środowiska i
   raportuje rozjazd.

Pytanie brzmiało: w czym to napisać. W trakcie analizy kontekst się zmienił -
git-identity przestał być jednorazowym narzędziem, a stał się pierwszym elementem
ekosystemu z planowanymi paczkami pomocniczymi. To unieważniło część wcześniejszego
rozumowania i wymusiło ponowny przegląd.

## Zebrane dane

Wszystkie liczby zmierzone lub zacytowane, nie oszacowane. Bez nich ten dokument
byłby zapisem czyjejś preferencji.

### Co robi ekosystem

Wyszukiwarka kodu GitHuba, pliki `hooks.json` zawierające `CLAUDE_PLUGIN_ROOT`,
baza 15 744 plików:

| Runtime | Wystąpienia | Udział |
|---|---:|---:|
| bash / shell | 6 192 | ~39% |
| node | 3 672 | ~23% |
| python / python3 | 2 800 | ~18% |
| bun | 482 | ~3% |
| uv | 293 | ~2% |
| npx | 199 | ~1,3% |

Wyniki nakładają się, więc to wskazanie kierunku, nie podział rozłączny.
Pluginy samego Anthropic (`skill-creator`, `frontend-design`, `serena`) nie mają
hooków w ogóle. Dokumentacja nie gwarantuje obecności żadnego runtime'u.

### Koszt wywołania, mierzony lokalnie

Hook odpala się przy każdym starcie sesji, więc liczy się każda dziesiątka
milisekund.

| Sposób | Czas |
|---|---:|
| jq | 6 ms |
| /bin/sh | 10 ms |
| node skrypt.mjs | 32 ms |
| python3 skrypt.py (3.14) | 32 ms |
| /usr/bin/python3 (3.9.6) | 45 ms |
| npx -y, ciepły cache | 390-550 ms |
| npx -y, wolny rejestr | 4 584 ms |
| **npx -y, brak sieci** | **70 310 ms**, potem błąd |

`bun build --compile` na skrypcie czytającym jeden JSON: **57 MB** binarki.
Pokrycie pięciu platform to około 285 MB w repozytorium, plus notaryzacja na
macOS, bez której Gatekeeper blokuje użytkownikowi pierwsze uruchomienie.

### Dostępność runtime'ów

| Runtime | macOS | Linux | Windows | Umie JSON |
|---|---|---|---|---|
| bash / sh | jest | jest | tylko z Git for Windows | nie |
| jq | `/usr/bin/jq` | do instalacji | do instalacji | tak |
| python3 | Xcode CLT | praktycznie zawsze | do instalacji | stdlib |
| node | do instalacji | do instalacji | do instalacji | natywnie |

Na Windowsie bash nie jest pewny: Git for Windows jest opcjonalny, a bez niego
Claude Code używa PowerShella.

### Czy Claude Code implikuje Node

Nie. Rekomendowana instalacja to natywny installer; są też Homebrew, WinGet,
apt, dnf i apk. Ścieżka npm nadal istnieje, ale dokumentacja mówi o niej:

> The npm package installs the same native binary as the standalone installer.
> (...) The installed `claude` binary does not itself invoke Node.

### Zależności w pluginach

Auto-instalacja odpala się, gdy w korzeniu pluginu są `package.json` **i**
lockfile: `npm ci --ignore-scripts` albo `bun install --frozen-lockfile --ignore-scripts`,
frozen, bez lifecycle scripts, limit 60 sekund.

Dokumentacja npm, domyślna wartość `--omit`:

> 'dev' if the `NODE_ENV` environment variable is set to 'production'; otherwise, **empty**

Czyli `npm ci` instaluje także `devDependencies`. Bez obejścia cały toolchain
deweloperski trafiałby na dysk każdego użytkownika pluginu.

Dokumentacja Claude Code o skutkach niepowodzenia:

> A failed or skipped install never blocks the plugin. (...)
> **A timed-out install can leave a partial `node_modules` tree in the cached copy.**

I furtka, z której korzystamy:

> Claude Code **skips `yarn.lock` and `pnpm-lock.yaml`** because Yarn and pnpm
> support resolution-time configuration hooks that bypass `--ignore-scripts`.

Żaden krok budowania nie uruchamia się przy instalacji pluginu.

### Weryfikacja mechanizmu `env` na żywym systemie

Przed napisaniem kodu sprawdzono, czy fundament w ogóle działa - na tej maszynie
nie istniał wcześniej ani jeden blok `env` w 16 plikach ustawień.

- `gh` pod podstawionym `GH_CONFIG_DIR` zgłosił brak logowania - mechanizm działa.
- `gh-axi` zwrócił `AUTH_REQUIRED`, co potwierdza dziedziczenie przez
  `execFile` bez opcji `env` na żywym procesie, nie tylko z lektury kodu.
- **`GIT_CONFIG_*` nie jest blokowane.** Wcześniejsze założenie, oparte na
  odczycie stringów sanitacji z binarki, okazało się fałszywe.
- Propagacja jest niedeterministyczna: utworzenie pliku potrafi zadziałać
  natychmiast, zmiana wartości wchodzi z opóźnieniem co najmniej jednego
  wywołania narzędzia, a usunięcie nie propaguje się w obrębie sesji w ogóle.

Wzorzec `[include]` sprawdzony na dwóch worktree tego samego repozytorium
jednocześnie: każdy z własnym `GIT_CONFIG_GLOBAL` zwracał własną tożsamość,
worktree bez zmiennej wracał do `~/.gitconfig`, a `core.autocrlf` przetrwał
z globalnego configu. Zero zapisów do stanu współdzielonego.

## Decyzja

### Architektura: podział po granicy zależności

**Rdzeń nie ma runtime'u.** Skille wykonują całą pracę narzędziami modelu.
Precedens jest pierwszoklasowy: wbudowany skill `update-config` operuje na tym
samym pliku, ma jako jedyne narzędzie `Read`, a jego instrukcja brzmi
„1. Decide 2. Read: Target file 3. Merge: Add to env object".

**Hook jest bonusem.** Jedyny plik z kodem. Jego brak odbiera jedną linię
raportu i nic więcej.

Ten podział jest ważniejszy niż wybór języka. Sprawia, że funkcjonalność działa
u każdego niezależnie od tego, co ma zainstalowane, a pytanie o runtime dotyczy
wyłącznie dodatku.

### Język: Node, plain ESM `.mjs`

Dla samego hooka byłby to rzut monetą - python3 i sh+jq wygrywają dostępnością.
Przesądził kontekst ekosystemu: **npm jest jedynym wbudowanym kanałem dystrybucji
kodu między pluginami**. Dla Pythona nie ma nic; dokumentacja odsyła do
bootstrapowania `uv` własnym kodem w hooku, czyli do budowania maszynerii.

Node ma też po swojej stronie dane: 3 672 wystąpienia wobec 2 800 dla Pythona.

TypeScript **nie** jako źródło w pluginie, dopóki nie ma bundlowania - żaden
build nie odpali się przy instalacji, więc `.ts` oznaczałoby commitowanie
artefaktów. Typy przez JSDoc, sprawdzane `tsc --checkJs --noEmit`.

### Tożsamość git: `GIT_CONFIG_GLOBAL`, nie `GIT_AUTHOR_*`

Profil dostaje własny plik gitconfig z `[include] path = ~/.gitconfig` na górze.
Przewaga nad zmiennymi `GIT_AUTHOR_*` jest jedna, ale istotna: `git config user.email`
raportuje prawdę. Przy zmiennych ta komenda pokazywałaby stary adres, mimo że
commity idą z nowym - mylące dla człowieka i dla każdego narzędzia, które czyta
konfigurację zamiast robić commit.

Cena: plik profilu jest współdzielony między sesjami, więc **zapis musi być
atomowy** - plik tymczasowy i `rename`. Przy zmiennych środowiskowych ten problem
nie istniałby, bo wartości są zamrożone w sesji.

Odrzucone: `git config --local user.email`. To jedyny wariant, który naprawdę
konfliktuje - local config jest współdzielony między wszystkimi worktree
repozytorium i widoczny dla każdej sesji oraz gołego terminala.

### Menedżer pakietów: pnpm

Rozwiązuje dylemat `devDependencies` bez żadnej maszynerii. `pnpm-lock.yaml`
daje odtwarzalne CI, a Claude Code pomija ten lockfile **z założenia producenta**,
nie przez lukę. Użytkownik nie instaluje nic.

### Stack

| Obszar | Wybór | Uzasadnienie |
|---|---|---|
| Typy | `tsc --checkJs --noEmit` + JSDoc | jedyne narzędzie łapiące tu realne błędy |
| Testy | `node --test` | wbudowane, zero zależności |
| Lint i format | Biome | jedna zależność zamiast kilkunastu, oba zadania naraz |
| Wersjonowanie | release-please | to samo co w bdk, gotowa konfiguracja |
| Node | `engines >=20`, `.nvmrc` | tam `node --test` jest stabilny |

Świadomie odrzucone: husky i lint-staged (CI wystarcza przy jednym pliku
źródłowym), commitlint (Conventional Commits egzekwuje release-please), Vitest,
bundler w fazie pierwszej.

## Konsekwencje

- Rdzeń funkcjonalności działa u każdego, na każdym systemie, bez instalowania
  czegokolwiek.
- Użytkownik bez Node traci jedną linię raportu przy starcie sesji. Nic więcej.
- Nie ma testu jednostkowego na scalanie JSON. Zastępują go jawne kroki w
  `SKILL.md`: przeczytaj plik w całości, pokaż diff przed zapisem.
- Ekosystem ma dwa języki - bdk zostaje w Pythonie. To akceptowane: bdk jest
  samowystarczalny, ma własne CI i nie musi konsumować tych helperów.
- Zapis pliku profilu musi być atomowy w każdym skillu, który go dotyka.

## Zaplanowana ścieżka: bundlowanie zamiast dowożenia

Gdy pojawi się pierwsza dzielona zależność, **nie** włączamy auto-instalacji
przez `npm ci`. CI bundluje ją do jednego samowystarczalnego pliku:

```
pnpm exec esbuild src/session-start.ts --bundle \
  --platform=node --format=esm --outfile=hooks/session-start.mjs
git diff --exit-code hooks/session-start.mjs
```

Bundlowanie wygrywa z dowożeniem na każdym wymiarze: użytkownik nie instaluje
nic i nigdy nie zainstaluje, działa offline i przy padniętym rejestrze, znika
limit 60 sekund i ryzyko częściowego `node_modules`. Zasada „zero importów spoza
`node:`" przestaje być obietnicą pilnowaną w review, a staje się właściwością
kształtu artefaktu - nie da się złamać czegoś, czego fizycznie nie ma.

Koszt: pluginy są konsumowane z gita, więc zbundlowany plik musi być
zacommitowany. Rozjazd ze źródłem wymuszamy mechanicznie przez
`git diff --exit-code` w CI, zamiast pilnować go w review. Zostaje szum w
diffach i jedna zależność deweloperska więcej.

Efekt uboczny: w tym momencie **TypeScript wraca do gry jako źródło**, bo build
dzieje się na CI, a nie przy instalacji.

## Warunki unieważnienia

- **Anthropic doda auto-instalację zależności Pythona** (np. `uv sync --frozen`
  z `uv.lock`). Wtedy Python wygrywa natychmiast: domyślna dostępność, spójność
  z bdk i ten sam kanał dystrybucji. Warto pilnować changeloga Claude Code.
- **Helpery mają być konsumowane przez bdk.** Wtedy język dyktuje bdk.
- **Po dwóch, trzech pluginach okaże się, że dzielonych helperów nie ma.**
  Wtedy prostszy byłby python3 stdlib-only. Ryzyko akceptowalne - koszt Node bez
  helperów to jeden `package.json` więcej, a nie architektura do zwinięcia.
- **Windows staje się platformą pierwszoklasową.** Wtedy warto dołożyć wrapper
  `.cmd` w stylu Superpowers, który na Windowsie szuka Git Basha, a gdy go nie
  znajdzie, kończy się cicho.

---

## Zasady dla pluginów Claude Code

Ta sekcja jest napisana bezosobowo i celowo oderwana od git-identity. Przy
kolejnym pluginie kopiuje się ją w całości, bez przepisywania rozumowania
powyżej.

### Runtime i hooki

1. **Hook nie importuje niczego spoza `node:`.** Instalacja zależności może paść
   albo przekroczyć 60 sekund i zostawić częściowe `node_modules`, więc kod z
   tego katalogu może po prostu nie istnieć w czasie wykonania.
2. **Brak runtime'u kończy hooka cichym sukcesem.** Wywołanie w `hooks.json`
   zabezpiecza się wzorcem `command -v <runtime> >/dev/null 2>&1 && <runtime> ... || true`.
   Brak funkcji bonusowej nigdy nie psuje cudzej sesji.
3. **Żadnego `npx` w hookach.** 0,4 s przy dobrej sieci, 70 sekund zwisu bez niej,
   przy każdym starcie sesji.
4. **Hook czyta `cwd` z payloadu na stdin**, nie z `process.cwd()`. Proces hooka
   nie musi startować w katalogu projektu. Stdin czyta się zawsze, nawet gdy
   payload jest niepotrzebny - inaczej wywołujący może zablokować się na pełnym
   potoku.
5. **Hook milczy, gdy nie ma czego powiedzieć.** Zepsuty plik konfiguracyjny to
   nie powód, żeby zaśmiecać każdą sesję.

### Zależności i budowanie

6. **Dopóki plugin nie ma zależności runtime - pnpm.** Odtwarzalne CI, a Claude
   Code pomija `pnpm-lock.yaml` z założenia, więc użytkownik nie ściąga
   toolchainu deweloperskiego. `npm ci` instaluje `devDependencies`.
7. **Zależności runtime bundluje się na CI**, nie dowozi przez auto-instalację.
   Zbundlowany artefakt jest commitowany, a jego zgodność ze źródłem wymusza
   `git diff --exit-code` w CI.
8. **TypeScript jako źródło dopiero wtedy, gdy istnieje krok bundlowania.** Przy
   instalacji pluginu żaden build się nie uruchamia.

### Architektura

9. **Rdzeń funkcjonalności nie ma runtime'u.** Logika operująca na plikach
   konfiguracyjnych należy do `SKILL.md`, a nie do skryptu. Wzorzec: wbudowany
   `update-config`.
10. **Skill modyfikujący cudzy plik czyta go w całości i pokazuje diff przed
    zapisem.** To zastępuje test jednostkowy, którego w tej warstwie nie ma.
11. **Zapis pliku współdzielonego między sesjami jest atomowy** - plik tymczasowy
    i `rename`.
12. **Nigdy nie pisać do współdzielonego `.claude/settings.json` ani do
    `.gitignore` projektu.** Wiązanie idzie do `settings.local.json`, a lokalne
    wykluczenie do `.git/info/exclude`.
13. **Plugin nie zakłada obecności innego pluginu.** Schemat wpisu w marketplace
    nie ma pola zależności, więc „B wymaga A" nie da się wyrazić ani sprawdzić.

### Przenośność

14. **`SKILL.md` i zwykłe skrypty przenoszą się między ekosystemami. Hooki i
    manifesty nie.** Każdy ekosystem ma własne nazwy zdarzeń i własną strukturę.
    Im mniej logiki w hooku, tym tańszy port.

### Weryfikacja

15. **Mechanizm platformy sprawdza się na żywym systemie przed napisaniem kodu,
    który na nim stoi.** Smoke test z kontrolą pozytywną i negatywną kosztuje
    pięć minut i rozstrzyga to, czego dokumentacja nie mówi wprost.
16. **Narzędzie weryfikujące sprawdza się kontrolą negatywną.** Typecheck albo
    linter, który przechodzi, bo niczego nie sprawdza, jest gorszy niż jego brak.
