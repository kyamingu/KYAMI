# KYAMI AI — دليل الإعداد (بالدارجة)

هاد الحزمة فيها واجهة AI Chat + Backend كيستعمل Gemini API. الواجهة تقدر تبقى فـ GitHub Pages، والـBackend كننشرّوه فـ Render.

## الملفات
- `index.html` و`style.css` و`app.js` و`config.js`: واجهة الموقع.
- `backend/server.js` و`backend/package.json`: سيرفر API آمن.

## 1) رفع واجهة الموقع لـ GitHub
1. حلّ https://github.com/kyamingu/KYAMI
2. دخل لـ `Add file` ثم `Upload files`.
3. رفع هاد الملفات من المجلد الرئيسي: `index.html`, `style.css`, `app.js`, `config.js`.
4. ضغط `Commit changes`.
5. دخل `Settings → Pages` وتأكّد Branch=`main` وFolder=`/(root)`.

مهم: خاصك ترفع الملفات الأربعة كاملين، وما تحطّش `backend/server.js` فالجذر بلا مجلد backend.

## 2) إنشاء مفتاح Gemini
1. دخل لـ https://aistudio.google.com/apikey
2. سجّل الدخول بحساب Google وأنشئ API key.
3. خليه سري. ما تلصقوش فـ `index.html` ولا `config.js` ولا GitHub.

Gemini كيوفّر استعمال مجاني لبعض النماذج، ولكن كاينين حدود وممكن يتبدّلو. راجع https://ai.google.dev/gemini-api/docs/pricing

## 3) نشر Backend فـ Render
1. فكّ الضغط على ZIP ورفع المجلد `backend` وملفاته لنفس Repository مع الحفاظ على المسار `backend/server.js` و`backend/package.json`.
2. دخل لـ https://render.com وسجّل الدخول باستعمال GitHub.
3. اختار `New +` → `Web Service`، ثم Repository ديال `kyamingu/KYAMI`.
4. الإعدادات:
   - **Root Directory:** `backend`
   - **Runtime / Language:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. فـ `Environment Variables` زِد:
   - `GEMINI_API_KEY` = المفتاح اللي خديتي من Google AI Studio
   - `GEMINI_MODEL` = `gemini-3.5-flash-lite` (اختياري، هادي القيمة الافتراضية)
   - `FRONTEND_ORIGINS` = `https://kyamingu.github.io`
6. فـ Health Check Path كتب `/health` إلا بان ليك الاختيار.
7. ضغط `Create Web Service` وسنّى حتى يبان Deploy ناجح. خذ رابط السيرفر بحال `https://kyami-api-xxxx.onrender.com`.

## 4) ربط الموقع بالـBackend
1. رجع لـ GitHub وفتح `config.js`.
2. ضغط Edit وبدّل `https://YOUR-RENDER-SERVICE.onrender.com` برابط Render ديالك الحقيقي (بلا `/` فالآخر).
3. ضغط `Commit changes` وانتظر GitHub Pages ينشر التحديث.
4. حلّ https://kyamingu.github.io/KYAMI/ وجرّب تسول KYAMI.

## ملاحظات مهمة
- Render Free كيدخل فالنوم بعد 15 دقيقة بلا طلبات؛ أول رسالة من بعد ممكن تتأخر حوالي دقيقة.
- المجاني ديال Gemini عندو rate limits ويمكن يوصل للحد ديالو.
- السيرفر فيه تحديد أولي للطلبات (20 طلب فـ10 دقايق لكل IP)، ولكن هادشي ماشي حماية كاملة من abuse. إلا الموقع ولا عامر بالمستخدمين، زيد حماية أقوى قبل الإطلاق.
- ما تشاركش API key مع حتى واحد. إلا تسرب، بدّلو فوراً من Google AI Studio.
