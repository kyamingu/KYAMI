# KYAMI + Ollama Cloud + Gemma — دليل الإعداد بالدارجة

هاد النسخة كتخلي واجهة KYAMI الموجودة فـ GitHub Pages تهضر مع **Ollama Cloud** باستعمال Backend منشور على Render. ما محتاجش تنصّب Ollama ولا تنزّل Gemma فالحاسوب ديالك؛ المعالجة كتكون عند Ollama Cloud.

## قبل ما تبدا: انتبه للتكلفة
- Ollama عندها خطة Free فيها starter usage credits وموديلات متاحة، ولكن الاستعمال السحابي ماشي مجاني بلا حدود. منين تسالي credits، ممكن تحتاج تزيد credits أو تختار خطة مناسبة. راجع الأسعار الحالية: https://ollama.com/pricing
- مثال التسعير الظاهر حالياً لـ Gemma 4 هو $0.14 لكل مليون input tokens و$0.40 لكل مليون output tokens؛ الأسعار والعروض ممكن تتبدل. راجع صفحة الموديل: https://ollama.com/library/gemma4
- ماتحطش `OLLAMA_API_KEY` فـ `config.js` ولا فـ GitHub. المفتاح كيبقى فـ Environment Variables ديال Render فقط.
- هاد الباك إند فيه حدود أولية للطلبات، ولكن بما أن الموقع public، شي حد يقدر يستعمل API ويستهلك credits ديالك. راقب usage ديالك، وما تشاركش رابط الباك إند بلا حاجة. هاد rate limits ماشي بديل كامل للمصادقة.

## 1) صايب Ollama Cloud API key
1. سجل الدخول فـ https://ollama.com/ .
2. دخل لإعدادات API keys من التوثيق الرسمي: https://docs.ollama.com/cloud
3. صايب API key واحتافظ به سرّي. ما ترسلوش لحتى واحد وما تديروش فملفات الموقع.

## 2) رفع ملفات المشروع إلى GitHub
خاص الملفات التالية يكونو فالجذر ديال repository `KYAMI`:
- `index.html`
- `style.css`
- `app.js`
- `config.js`

وزيد مجلد `backend` كامل (فيه `server.js` و`package.json`) داخل نفس repository باش Render يقدر يلقاه. ما ترفعش أي ملف `.env` أو API key.

## 3) نشر الـ Backend على Render
1. دخل لـ https://render.com وسجّل الدخول.
2. اختار **New → Web Service** وربط GitHub repository `kyamingu/KYAMI`.
3. فإعدادات الخدمة، حط **Root Directory** = `backend`.
4. **Runtime** = Node. **Build Command** = `npm install`. **Start Command** = `npm start`.
5. اختار الخطة اللي مناسبة ليك. Free web services كتنعس بعد فترة بلا طلبات، وبالتالي أول طلب ممكن يتأخر. شوف الحدود: https://render.com/docs/free
6. فـ Environment Variables زيد:

   - `OLLAMA_API_KEY` = لصق API key ديالك (Secret).
   - `OLLAMA_BASE_URL` = `https://ollama.com`
   - `FRONTEND_ORIGINS` = `https://kyamingu.github.io`
   - `IP_REQUEST_LIMIT` = `8`
   - `GLOBAL_HOURLY_LIMIT` = `100`

6. ضغط Deploy وانتظر حتى تولّي الخدمة Live. خذ URL ديالها، مثلاً `https://kyami-cloud-api.onrender.com` (الرابط الحقيقي كيظهر ليك فـ Render).
7. جرّب فتح `https://YOUR-RENDER-SERVICE.onrender.com/health`؛ خاصها تجاوب بشي JSON فيه `provider: "Ollama Cloud"` و`configured: true`. إلا كانت `configured: false`، راجع `OLLAMA_API_KEY`.
8. جرّب `https://YOUR-RENDER-SERVICE.onrender.com/api/models`. خاصها ترجع قائمة موديلات Gemma المتاحة للحساب ديالك. إلا كانت خاوية، راجع صلاحية الحساب والموديلات والـusage.

> Render Free مناسب للتجربة، ماشي ضمان خدمة دائمة. أول طلب من بعد النوم ممكن يتأخر. وثائق Render: https://render.com/docs/free

## 4) ربط GitHub Pages بالباك إند
1. فـ GitHub افتح `config.js` وضغط Edit.
2. بدّل `https://YOUR-RENDER-SERVICE.onrender.com` برابط Render الحقيقي ديالك، بلا `/` فالأخير. مثال:

```js
window.KYAMI_CONFIG = {
  apiBaseUrl: "https://kyami-cloud-api.onrender.com"
};
```

3. احفظ بـ Commit changes.
4. افتح https://kyamingu.github.io/KYAMI/ وعاود حمّل الصفحة. خاص قائمة Gemma تتعبّى بالموديلات اللي رجعات من Ollama Cloud API.
5. اختار الموديل وجرّب إرسال سؤال.

## 5) إلا ما خدمش
- **Backend is missing OLLAMA_API_KEY:** زيد المفتاح فـ Render Environment Variables ودير redeploy/restart.
- **Website origin not allowed:** تأكد أن `FRONTEND_ORIGINS` هي `https://kyamingu.github.io` بلا مسار `/KYAMI`.
- **ما كيبان حتى Gemma:** جرّب `/api/models` وتأكد أن الحساب عندو وصول لموديلات Gemma Cloud. الأسماء اللي كترجعها API هي اللي خاص التطبيق يستعملها.
- **429 أو usage limit:** راجع https://ollama.com/pricing وعداد الاستعمال.
- **الموقع ما كيتاصلش:** راجع أن `apiBaseUrl` كيشير لـ Render service الصحيحة، وأن الخدمة Live.

## كيفاش خدام الربط؟
المتصفح كيهضر مع Backend ديال Render؛ والباك إند فقط هو اللي كيهضر مع `https://ollama.com/api/chat` باستعمال `Authorization: Bearer ...`. المفتاح السري ما كيوصلش للمتصفح. الموقع static فـ GitHub Pages، والـAI hosted من عند Ollama Cloud.
