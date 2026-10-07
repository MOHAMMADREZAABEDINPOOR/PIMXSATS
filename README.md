<div align="center">

<img src="assets/readme/hero.gif" width="1200" alt="PIMX SATS — rotating 3D geometry" />

**[English](README.md) · [فارسی](README.fa.md)**

<img src="assets/readme/identity.svg" width="1200" alt="space / English and Persian documentation" />

</div>

# PIMX SATS

An interactive satellite and solar-system explorer. A Three.js globe, satellite.js orbit propagation and pass predictions turn orbital data into a visual workspace.

[GitHub](https://github.com/MOHAMMADREZAABEDINPOOR/PIMXSATS) · [PIMX / Profile](https://github.com/MOHAMMADREZAABEDINPOOR) · [Static artwork](assets/readme/hero.png)

## Features

- Three-dimensional Earth, satellites and ground tracks
- Observer location, overhead passes and sky view
- Favorites, comparisons, orbital history and conjunction panels
- Solar-system views, space weather and orbital sonification

## Stack

| Tool | Version / source |
|---|---|
| React | `^19.2.1` |
| Next.js | `^15.4.9` |
| TypeScript | `5.9.3` |
| Three.js | `^0.185.1` |
| React Three Fiber | `^9.6.1` |
| Motion | `^12.23.24` |
| Tailwind CSS | `4.1.11` |

## Getting started

Node.js 22.12+ and the package manager declared in package.json. Install dependencies from the checked-in lockfile where available.

```bash
git clone https://github.com/MOHAMMADREZAABEDINPOOR/PIMXSATS.git
cd PIMXSATS

npm ci
npm run dev
```

## Configuration

These names are found in the example configuration or source; not all are required. Check their defaults/usage in those files and supply secrets only in your local or hosting environment.

| Name | Role |
|---|---|
| `APP_URL` | Application setting; inspect its definition |
| `GEMINI_API_KEY` | Credential/connection setting; keep private |

## Usage

Open the dashboard, choose a satellite and set your observer location. Switch between the globe, sky view and passes panel. Refresh the bundled TLE snapshot with `npm run snapshot`.

## Project structure

| Path | Role |
|---|---|
| [`app/`](app/) | Application routes / PHP application |
| [`assets/`](assets/) | Brand/media/README assets |
| [`components/`](components/) | Reusable interface components |
| [`lib/`](lib/) | Shared application modules |
| [`public/`](public/) | Public web assets |
| [`scripts/`](scripts/) | Development and maintenance utilities |
| [`metadata.json`](metadata.json) | Project entry/configuration file |
| [`package.json`](package.json) | Project entry/configuration file |
| [`tsconfig.json`](tsconfig.json) | Project entry/configuration file |

## Commands and checks

```bash
npm run dev
npm run snapshot
npm run build
npm run start
npm run lint
npm run check:controls
```

These commands are declared in package.json; the list is not a test execution report. Test commands may need a browser, service or prepared database.

## Deployment

Deploy the build according to its architecture: server-backed projects need a Node process; static Vite frontends can host dist. Pages functions, KV or D1 require separate configuration.

## Limitations

TLE data ages and orbital predictions are approximate. Network access is needed for fresh data; geolocation is optional. This is an educational explorer, not an operational tracking service.

## Troubleshooting

- Missing packages: install dependencies using the project’s package manager.
- API/network failure: check the configured origin, provider and hosting bindings.
- Old assets: rebuild when a build script exists, then clear the browser cache.

## Contributing

Create a focused branch, verify the affected behavior and explain the change clearly. Keep private data, build outputs and local databases out of commits.

## License

No repository-level license file is included in this snapshot. Public visibility alone does not grant reuse rights; contact the repository owner for terms.

---

Part of **PIMX** · Documentation in English and Persian.
