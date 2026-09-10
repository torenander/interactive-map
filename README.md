# areamap

[![CI](https://github.com/torenander/interactive-map/actions/workflows/ci.yml/badge.svg)](https://github.com/torenander/interactive-map/actions/workflows/ci.yml)

Personligt kartverktyg för att betygsätta stadsdelar i London under en
bostadssökning. Rita en polygon, sätt ett betyg och en kommentar, kom
tillbaka till den senare. Full spec: `SPEC.md`.

Status: MVP klar (mål G1–G5, se `docs/OBJECTIVES.md`).

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
npm run test       # vitest, unit
npm run test:e2e   # playwright, mobil viewport
```

Se `docs/TESTING.md` för vad som testas och `docs/ARCHITECTURE.md` /
`docs/DATA-MODEL.md` för varför och hur.
