# Get Diamond Info — HTML/CSS/JS + Node.js version

This is a rewrite of the original ASP.NET MVC (.NET Framework 4.6.1) "GetDiamondInfo"
app so it runs anywhere with Node.js — no Visual Studio or IIS required. It works
great in **VS Code**.

## What changed vs. the original

| Original (ASP.NET MVC)              | This version                          |
|---------------------------------------|----------------------------------------|
| C# `HomeController` + Razor `.cshtml` views | Plain HTML pages + a small Express API |
| `StoneModel` / `ParcelModel` scanning a Windows folder | `server.js` does the same scan with Node's `fs` module |
| SQL Server lookup for external video links | Optional, via the `mssql` package — safely skipped if not configured |
| `Web.config` `<appSettings>` | `.env` file |

The **behavior is the same**: given a certificate number, it finds matching images
and videos in a media folder; given a parcel number, it finds images matching the
`_bg` / `_Fluo` / `_Mix` / `_Phospho` naming patterns.

## Project structure

```
diamond-info-webapp/
├── server.js            # Express backend (replaces HomeController + Models)
├── package.json
├── .env.example          # copy to .env and configure
├── sample-media/         # a few placeholder images so the demo works out of the box
└── public/                # the whole "HTML/CSS/JS" frontend
    ├── index.html         # cert/parcel number lookup form
    ├── stone.html          # certificate/stone details page
    ├── parcel.html         # parcel gallery page
    ├── about.html
    ├── contact.html
    ├── css/style.css
    └── images/no-image-available.svg
```

## Running it (in VS Code or any terminal)

1. Install [Node.js](https://nodejs.org/) (LTS version) if you don't have it.
2. Open this folder in VS Code.
3. Open a terminal (``Ctrl+` ``) and run:

   ```bash
   npm install
   cp .env.example .env
   npm start
   ```

4. Open **http://localhost:3000** in your browser.

By default it points at the bundled `sample-media` folder so you can try it
immediately:
- Certificate lookup: try `2221514363`
- Parcel lookup: try `2222_12302024_111`

## Pointing it at your real media folder

Edit `.env`:

```
MEDIA_FOLDER_PATH=D:\TEMP\Media        # Windows
MEDIA_FOLDER_PATH=/mnt/d/TEMP/Media    # Linux/macOS/WSL
```

Restart the server (`npm start`) after changing `.env`.

## Enabling the external video link database (optional)

The original app queried a SQL Server database for extra video links. That part
is optional here — if you don't set `DB_SERVER` in `.env`, the app simply skips
it (same graceful fallback as the original's try/catch). To enable it, fill in:

```
DB_SERVER=your-server
DB_NAME=your-db
DB_USER=your-user
DB_PASSWORD=your-password
```

**Security note:** the original `Web.config` had real database credentials
committed in plain text. Don't commit real credentials to `.env` in source
control — add `.env` to `.gitignore` (already done) and use a secrets manager
or environment variables in production instead.

## Notes on what was intentionally simplified

- The original used jQuery plugins (Blueimp gallery, ninja-slider, thumbnail-slider,
  Bootstrap) for the image carousel. This version uses a small vanilla-JS
  click-to-enlarge lightbox instead, so there are no external JS framework
  dependencies on the frontend — just embedded `<script>` tags.
- Logging (`log4net`) was replaced with simple `console.log`/`console.error` calls.
  Swap in a package like `winston` if you want file-based logging.
