# areamap

[![CI](https://github.com/torenander/interactive-map/actions/workflows/ci.yml/badge.svg)](https://github.com/torenander/interactive-map/actions/workflows/ci.yml)

Personligt kartverktyg för att betygsätta stadsdelar i London under en
bostadssökning. Rita en polygon, sätt ett betyg och en kommentar, kom
tillbaka till den senare. Full spec: `SPEC.md`.

Status: mål G1–G13 avklarade, utom G12 som stängts som ogenomförbart efter mätning
(se `docs/OBJECTIVES.md`).

## Förkrav

Två saker utöver Node 24 och npm. Ingen av dem är ett npm-beroende, så en färsk klon
går annars bet — `scripts/fetch-tiles.sh` respektive `npm run test:e2e` misslyckas.

- **pmtiles CLI** (go-pmtiles), som `scripts/fetch-tiles.sh` anropar. CI installerar
  v1.31.2:

  ```bash
  curl -sSL -o /tmp/pmtiles.tar.gz \
    https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz
  tar -xzf /tmp/pmtiles.tar.gz -C /tmp pmtiles
  sudo install /tmp/pmtiles /usr/local/bin/pmtiles
  ```

  På macOS: `brew install pmtiles`.

- **Playwright-webbläsarna**, för e2e-sviterna:

  ```bash
  npx playwright install --with-deps webkit chromium
  ```

`.github/workflows/ci.yml` är sanningskällan för vad vägen faktiskt kräver — det är den
som körs vid varje push, och versionerna ovan är dess.

## Kom igång

```bash
git clone <repo> && cd interactive-map
npm install
npx supabase start
cp .env.example .env        # fyll i värden från: npx supabase status -o env
scripts/fetch-tiles.sh
npx supabase db reset
npm run dev
```

Test:

```bash
npm run test                                      # vitest, unit
npm run test:e2e -- --project=mobile              # playwright, WebKit 390x844
npm run test:e2e -- --project=desktop --workers=1 # playwright, Chromium 1440x900
```

Se `docs/TESTING.md` för vad som testas och `docs/ARCHITECTURE.md` /
`docs/DATA-MODEL.md` för varför och hur.
