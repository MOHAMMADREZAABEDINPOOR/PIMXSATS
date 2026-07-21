<div align="center">
<h1>PIMXSATS 🛰️🌌</h1>
<p><strong>Real-Time 3D Satellite & Solar System Tracker</strong></p>
</div>

[![Persian Description](https://img.shields.io/badge/Read-Persian%20Description-0A66C2?style=for-the-badge)](#persian-description)
[![Website](https://img.shields.io/badge/Live-pimxsats.pages.dev-0ea5e9?style=for-the-badge)](https://pimxsats.pages.dev/)

---

## 🌐 Live Website

**Production URL:** [https://pimxsats.pages.dev/](https://pimxsats.pages.dev/)

---

## 🧩 What is PIMXSATS?

PIMXSATS is a modern web application that renders the entire population of active Earth satellites — **25,000+ objects** — live in an interactive 3D scene, together with a full real-time Solar System. Every satellite is propagated on your device with the industry-standard **SGP4/SDP4** orbital model from real TLE (Two-Line Element) data, so what you see is where the spacecraft actually are, right now — or at any moment in history you time-travel to.

### Key Capabilities:
- 🛰️ **25,000+ Live Satellites** propagated with SGP4 from real CelesTrak TLE data
- 🌍 **Physically Accurate Earth** — day/night terminator from a real solar ephemeris, night lights, live cloud layer
- 🪐 **Full Solar System View** — planets from JPL Keplerian elements, 25+ real moons, ~30 real deep-space probes (Voyager, New Horizons, JWST, …)
- ⏳ **Time Travel** — jump hours to decades into the past or future; the satellite catalog adapts to what existed at that date
- 🎯 **Focus Tracking Camera** — lock onto any satellite and ride along its orbit
- 🔍 **Search & Filters** — by name, category (Starlink, Navigation, Weather, Stations, Debris, …) and orbit regime (LEO / MEO / GEO / HEO)
- 📡 **Coverage Footprint** — geometrically correct horizon cone and ground ring for any altitude
- 📱 **Fully Responsive** — touch-friendly picking, mobile drawer and bottom-sheet UI
- 🔒 **No Accounts, No Tracking** — everything renders client-side; no API keys required

---

## ✨ Core Features

### 🌍 Earth Orbit View
- The complete active catalog as an instanced 3D swarm, colored by category
- High-detail **procedural 3D models** for the selected satellite, with variants per spacecraft type
- Osculating-ellipse **orbit path** — a mathematically closed loop for LEO through HEO
- Live altitude, speed, footprint radius and covered-area stats for the selection
- Free-rotation trackball camera with collision guard and a one-tap **LEVEL VIEW** re-straighten button

### 🪐 Solar System View
- Planets positioned in real time from JPL Keplerian elements; the Moon from a lunar ephemeris
- Planetary orbiters, lunar orbiters, Lagrange-point observatories and escape-trajectory probes
- The live Earth satellite swarm rendered around Earth at its true angular positions

### ⏳ Time Engine
- Warp presets from real time up to millions of × speed, independent per view
- Jump buttons (±1h / ±1d / ±30d / ±1y) or an exact date-time picker
- Historical accuracy: satellites launched after the simulated date disappear from the sky
- Clock based on the device's real location (OS timezone + optional GPS — VPN-independent)

### ⚡ Performance Engineering
- **Time-budgeted propagation loop** — SGP4 work is spread across frames, so 25k satellites never block rendering
- **Velocity-extrapolation cache** — full deep-space re-propagation runs a few times per minute per satellite instead of every frame (~580× cheaper in historical mode)
- Instanced billboard sprites with direct matrix-buffer writes and analytic ray picking
- Logarithmic depth buffer for artifact-free rendering from 100 km up to 60 AU

---

## 🔐 Data & Privacy Model

- **No sign-up, no cookies, no analytics.** The app is a pure client-side renderer.
- The full ~16k-object TLE catalog is bundled with the site (`public/tle-snapshot.txt`) and refreshed from CelesTrak + daily-refreshed GitHub mirrors at every build — visitors never wait on (or connect to) third-party TLE APIs.
- Your view settings and selections live only in the running page. Nothing about you is stored anywhere.

---

## 🛠 Tech Stack

| Technology | Purpose |
|------------|---------|
| **Next.js 15** | App framework & TLE proxy API routes |
| **React 19** | UI framework |
| **TypeScript 5** | Type-safe development |
| **three.js + React Three Fiber** | 3D rendering |
| **@react-three/drei** | Camera controls & 3D helpers |
| **satellite.js** | SGP4/SDP4 orbital propagation |
| **Tailwind CSS 4** | Styling |
| **Lucide** | Icons |
| **Cloudflare Pages** | Hosting & deployment |

---

## 🚀 Local Development

### Prerequisites
- Node.js 18+ (20+ recommended)
- npm

### Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MOHAMMADREZAABEDINPOOR/PIMXSATS.git
   cd PIMXSATS
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the development server:**
   ```bash
   npm run dev
   ```
   Open your browser at: [http://localhost:3000](http://localhost:3000)

4. **Build for production:**
   ```bash
   npm run build
   npm start
   ```

5. **(Optional) Refresh the bundled TLE snapshot:**
   ```bash
   node scripts/fetch-tle-snapshot.mjs
   ```

No API keys are required — the full-sky TLE snapshot is bundled into the site and refreshed automatically by the `prebuild` step on every build (`npm run snapshot` refreshes it manually).

---

## ☁️ Cloudflare Pages Deployment

This repository deploys to **[pimxsats.pages.dev](https://pimxsats.pages.dev/)**.

**Build Settings:**
- **Framework preset:** Next.js
- **Build command:** `npx @cloudflare/next-on-pages@1`
- **Build output directory:** `.vercel/output/static`
- **Node.js version:** 18+

**Required compatibility flag** (Pages → Settings → Functions):
```
nodejs_compat
```

**⚠️ Note:** The satellite catalog is baked into the build (`prebuild` refreshes `public/tle-snapshot.txt`; if upstream sources are unreachable the last-known-good snapshot is kept, so the build never fails). A service worker precaches the catalog and all textures, so repeat visits start instantly and work offline.

---

## 📁 Project Structure

```
PIMXSATS/
├── app/
│   ├── page.tsx                # Entry page
│   ├── layout.tsx              # Root layout, viewport & metadata
│   ├── globals.css             # Design system (glass panels, motion)
│   └── api/
│       ├── tle/                # TLE aggregation proxy + progress endpoint
│       └── clouds/             # Live global cloud-cover texture
├── components/
│   ├── SatelliteApp.tsx        # App shell, preloading, time engine
│   ├── TrackerCanvas.tsx       # 3D scene, tracking camera, coverage cone
│   ├── Earth.tsx               # Day/night shader Earth
│   ├── Satellites.tsx          # Instanced 25k-satellite swarm
│   ├── SatelliteModel.tsx      # Procedural detailed spacecraft models
│   ├── SolarSystemView.tsx     # Planets, moons, probes scene
│   └── UIOverlay.tsx           # Responsive UI, filters, time travel
├── lib/
│   ├── satellite.ts            # TLE parsing, SGP4 helpers, cached propagation
│   ├── astronomy.ts            # Solar/planetary/lunar ephemeris, Kepler solver
│   ├── solar-system.ts         # Planet, moon & spacecraft catalog
│   └── circle-sprite.ts        # Billboarded dot shader
├── public/
│   ├── textures/               # Earth day/night/specular/cloud maps
│   └── tle-snapshot.txt        # Bundled ~25k-object TLE snapshot
├── scripts/
│   └── fetch-tle-snapshot.mjs  # Snapshot refresher
└── package.json
```

---

## 🔧 Orbital Math Details

**Propagator:** SGP4 / SDP4 (via satellite.js)
**Input:** NORAD Two-Line Elements, merged from multiple live sources
**Frames:** TEME → scene mapping with real GMST Earth rotation
**Orbit paths:** osculating ellipse from the instantaneous state vector
**Sanity guards:** decayed/diverged propagations are detected and hidden

Positions match professional tracking tools to within the accuracy of the underlying TLEs.

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📞 Support & Contact

For issues, questions, or suggestions, please open an issue on GitHub or contact the maintainer.

---

<a id="persian-description"></a>

# PIMXSATS 🛰️🌌
## توضیحات فارسی

**PIMXSATS** یک ردیاب سه‌بعدی و بلادرنگ ماهواره‌ها و منظومه شمسی است که **بیش از ۲۵,۰۰۰ ماهواره فعال** را به‌صورت زنده در مرورگر شما نمایش می‌دهد. موقعیت هر ماهواره با مدل استاندارد **SGP4/SDP4** و از روی داده‌های واقعی TLE محاسبه می‌شود — یعنی دقیقاً همان‌جایی را می‌بینید که ماهواره همین حالا هست، یا هر لحظه‌ای از گذشته و آینده که با سفر در زمان انتخاب کنید.

### ✨ ویژگی‌های اصلی:
- 🛰️ **۲۵,۰۰۰+ ماهواره زنده** با انتشار مداری SGP4 از داده‌های واقعی CelesTrak
- 🌍 **زمین با دقت فیزیکی** — مرز شب و روز از افمریس واقعی خورشید، نورهای شب و لایه ابر زنده
- 🪐 **نمای کامل منظومه شمسی** — سیارات با المان‌های کپلری JPL، بیش از ۲۵ قمر واقعی و حدود ۳۰ کاوشگر واقعی (وویجر، نیوهورایزنز، JWST و…)
- ⏳ **سفر در زمان** — از چند ساعت تا چند دهه به گذشته یا آینده؛ کاتالوگ ماهواره‌ها با تاریخ انتخابی هماهنگ می‌شود
- 🎯 **دوربین تعقیب** — روی هر ماهواره قفل کنید و همراه مدارش حرکت کنید
- 🔍 **جستجو و فیلتر** — بر اساس نام، دسته (استارلینک، ناوبری، هواشناسی، ایستگاه‌ها، زباله فضایی و…) و رژیم مداری (LEO / MEO / GEO / HEO)
- 📡 **ردپای پوشش** — مخروط افق و حلقه زمینیِ هندسی‌درست برای هر ارتفاعی
- 📱 **کاملاً واکنش‌گرا** — انتخاب لمسی، کشوی موبایل و کارت اطلاعات پایین‌صفحه
- 🔒 **بدون حساب کاربری و بدون ردیابی** — همه‌چیز سمت کلاینت رندر می‌شود؛ به هیچ کلید API نیاز نیست

### ⚡ مهندسی کارایی
- **حلقه انتشار با بودجه زمانی** — محاسبات SGP4 بین فریم‌ها پخش می‌شود تا ۲۵ هزار ماهواره هرگز رندر را مسدود نکند
- **کش برون‌یابی سرعت** — انتشار کامل مدارهای عمیق به‌جای هر فریم، تنها چند بار در دقیقه اجرا می‌شود (در حالت تاریخی حدود ۵۸۰ برابر سبک‌تر)
- اسپرایت‌های نمونه‌سازی‌شده با نوشتن مستقیم بافر ماتریس و انتخاب تحلیلی پرتو

### 🔐 حریم خصوصی
- **بدون ثبت‌نام، بدون کوکی، بدون آنالیتیکس.** این برنامه یک رندرکننده کاملاً سمت کلاینت است.
- کاتالوگ کامل TLE (~۱۶ هزار شیء) همراه خود سایت ارائه می‌شود (`public/tle-snapshot.txt`) و در هر بیلد به‌روزرسانی می‌گردد — بازدیدکننده هرگز منتظر دانلود داده از APIهای خارجی نمی‌ماند.
- هیچ داده‌ای از شما در هیچ‌کجا ذخیره نمی‌شود.

### 🛠 پشته تکنولوژی
| تکنولوژی | هدف |
|---------|-----|
| **Next.js 15** | فریم‌ورک برنامه و مسیرهای API |
| **React 19** | فریم‌ورک UI |
| **TypeScript 5** | توسعه با تایپ ایمن |
| **three.js + React Three Fiber** | رندر سه‌بعدی |
| **satellite.js** | انتشار مداری SGP4/SDP4 |
| **Tailwind CSS 4** | طراحی و استایل‌دهی |
| **Lucide** | آیکون‌ها |
| **Cloudflare Pages** | هاست و استقرار |

### 🚀 راه‌اندازی محلی

**پیش‌نیازها:**
- Node.js 18+ (نسخه ۲۰ به بالا توصیه می‌شود)

**مراحل نصب:**

1. **کلون ریپازیتوری:**
   ```bash
   git clone https://github.com/MOHAMMADREZAABEDINPOOR/PIMXSATS.git
   cd PIMXSATS
   ```

2. **نصب وابستگی‌ها:**
   ```bash
   npm install
   ```

3. **اجرای سرور توسعه:**
   ```bash
   npm run dev
   ```
   آدرس: [http://localhost:3000](http://localhost:3000)

4. **ساخت نسخه تولید:**
   ```bash
   npm run build
   npm start
   ```

به هیچ کلید API نیازی نیست — داده‌های زنده TLE از طریق پراکسی داخلی دریافت و کش می‌شوند و یک اسنپ‌شات کامل نیز برای حالت آفلاین همراه پروژه است.

### ☁️ استقرار روی Cloudflare Pages

این ریپازیتوری روی **[pimxsats.pages.dev](https://pimxsats.pages.dev/)** مستقر می‌شود.

**تنظیمات ضروری:**
- **Framework preset:** Next.js
- **Build command:** `npx @cloudflare/next-on-pages@1`
- **Build output directory:** `.vercel/output/static`
- **Node.js:** 18+
- **Compatibility flag:** `nodejs_compat`

---

**Made with ❤️ by [Mohammad Reza Abedinpoor](https://github.com/MOHAMMADREZAABEDINPOOR)**
