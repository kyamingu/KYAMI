# KYAMI AI — Your AI Companion

KYAMI هو مساعد ذكي بواجهة ويب ثابتة. الواجهة تستعمل Cloudflare Worker كـ API، والـ Worker يرسل الطلبات إلى Cloudflare Workers AI باستعمال الموديل الوحيد المفعّل حالياً:

`@cf/google/gemma-4-26b-a4b-it`

لا توجد حسابات أو قاعدة بيانات أو بحث على الويب أو ذاكرة سحابية في النسخة الحالية. المحادثات تُخزّن محلياً في `localStorage` داخل المتصفح.

## البنية الحالية

- **الواجهة:** `index.html` و`style.css` و`app.js` و`config.js`.
- **API وAI:** `src/index.js`؛ المسارات الديناميكية `/api/*` تمر عبر Worker أولاً.
- **الملفات الثابتة:** تُقدَّم من مجلد المشروع الرئيسي باستعمال `ASSETS`.
- **الموديل:** يختاره Worker من الخادم، ولا يمكن للمتصفح اختيار موديل آخر.

ملفات `server.js` و`render.yaml` وبعض إعدادات `package.json` قديمة ولا تشغّل بنية Cloudflare الحالية. `npm start` يشغّل خادماً قديماً منفصلاً؛ لا تستخدمه لتشغيل KYAMI الحالي. أبقينا الملفات للمراجعة ولم نحذفها.

## API

### `GET /api/health`

يرجع حالة الخدمة واسم المزود والموديل الحالي:

```json
{"status":"ok","provider":"Cloudflare Workers AI","model":"@cf/google/gemma-4-26b-a4b-it"}
```

### `GET /api/models`

```json
{"models":["@cf/google/gemma-4-26b-a4b-it"]}
```

### `POST /api/chat`

يجب إرسال `Content-Type: application/json` والبيانات التالية:

```json
{"messages":[{"role":"user","text":"مرحبا"}],"model":"@cf/google/gemma-4-26b-a4b-it"}
```

حقل `model` اختياري؛ إن أُرسل، يجب أن يطابق الموديل المعتمد. يجب أن تبدأ الرسائل بدور `user`، وتتبادل الأدوار بين `user` و`assistant`، وتنتهي برسالة `user`.

النجاح:

```json
{"reply":"...","model":"@cf/google/gemma-4-26b-a4b-it"}
```

الخطأ:

```json
{"error":"Too many requests. Please wait before trying again.","code":"RATE_LIMITED","message":"Too many requests. Please wait before trying again.","resetAt":"..."}
```

رموز الأخطاء تشمل `INVALID_JSON`, `INVALID_MESSAGES`, `UNSUPPORTED_MODEL`, `REQUEST_TOO_LARGE`, `CONTEXT_TOO_LARGE`, `RATE_LIMITED`, `RATE_LIMITER_UNAVAILABLE`, `AI_QUOTA_EXHAUSTED`, `AI_CAPACITY_LIMITED`, `AI_TIMEOUT`, و`AI_UNAVAILABLE`. عند `429 RATE_LIMITED` يعيد الخادم `Retry-After` ووقت إعادة الضبط؛ لا تعيد الواجهة الطلب تلقائياً.

## حدود الطلب والحماية

- حجم جسم الطلب: 256 KiB كحد أقصى، ويُفحص أثناء قراءة البيانات.
- 1 إلى 20 رسالة لكل طلب.
- 8,000 حرف كحد أقصى للرسالة الواحدة.
- 30,000 حرف كحد أقصى لسياق المحادثة؛ الواجهة ترسل أحدث الرسائل التي تلائم الحد، دون حذف السجل المحلي.
- خرج الموديل محدود بـ768 token.
- مهلة انتظار الواجهة الخلفية 45 ثانية؛ لا تعيد الواجهة الطلب تلقائياً. هذه المهلة تحد وقت انتظار Worker فقط؛ لم توثق واجهة `env.AI.run()` المستخدمة هنا إلغاء الاستدلال عند انتهاء المهلة، لذلك قد يستمر استهلاك الحصة حتى لو انتهى طلب HTTP.
- حد دائم موزع: 5 طلبات توليد لكل IP موثوق من `CF-Connecting-IP` خلال نافذة ثابتة من 60 ثانية. يحوّل Worker العنوان إلى SHA-256 قبل إرساله إلى Durable Object؛ لا يُخزّن IP الخام.
- يوزّع المفتاح على 16 هوية Durable Object ثابتة باستخدام أول بايت من SHA-256 modulo 16. كل IP له سجل واحد ثابت، وتخزن SQLite مفتاح SHA-256 ووقت النافذة والعداد ووقت الانتهاء فقط.
- حد ثانوي محلي: أربع استدعاءات AI متزامنة لكل Worker isolate. هذا حاجز تزامن محلي، وليس محدد المعدل الدائم.

إذا تعذر استخدام Durable Object أو فشلت SQLite، يرفض Worker التوليد بخطأ `503 RATE_LIMITER_UNAVAILABLE` ولا يرجع إلى محدد ذاكرة. طلبات الصحة والموديلات لا تستخدم Durable Objects. إذا لم يصل `CF-Connecting-IP`، تشترك تلك الطلبات في bucket احتياطي واحد؛ لا نثق بـ`X-Forwarded-For`.

## Durable Objects وخطة Workers Free

يستخدم `RATE_LIMITER` الفئة `KyamiRateLimiter` مع SQLite ومفاتيح IDs ثابتة لـ16 shard. الإعداد declarative عبر `exports` في Wrangler، ولا يستخدم تدفق `migrations` القديم أو backend من نوع KV. كتابة namespace في الإعداد لا تنشئ namespace في الحساب؛ Cloudflare ينشئها عند أول نشر، ولم يحدث نشر أو provisioning في هذه المرحلة.

خوارزمية الحد: فحص مفتاح مفهرس ثم معاملة متزامنة تقرأ العداد وتزيده بـupsert للطلبات المقبولة. الخمسة الأولى تُقبل، والسادس يُرفض من دون كتابة. تبدأ النافذة عند أول طلب وتُعاد بعد 60 ثانية. يرسل API الوقت المتبقي و`Retry-After` على 429.

تنتهي سجلات عدم النشاط بعد 30 يوماً. عند طلب chat صالح، يفحص scheduler إنذار الكائن؛ إذا لم يوجد، يسلّح إنذاراً أسبوعياً، ولا يستبدل إنذاراً قائماً بأقرب منه. كل كائن يملك إنذاراً واحداً، وتُسلسل عمليات الفحص والجدولة مع معالج الإنذار لتجنب التكرار أو استبدال موعد أقرب. ينفذ الإنذار حذفاً مفهرساً محدوداً إلى 500 سجل؛ إذا بقيت دفعة كاملة، يعيد الجدولة بعد ثانية.

إذا فشل `getAlarm()` أو `setAlarm()` أثناء فحص طلب chat، يرد المحدد بخطأ آمن `503 RATE_LIMITER_UNAVAILABLE` قبل زيادة العداد أو استدعاء AI. وإذا فشل المعالج في جدولة الإنذار التالي، يترك الخطأ يصل إلى Cloudflare لإعادة محاولة الإنذار (حتى ست مرات)؛ وبعد استنفادها، يفحص طلب chat لاحق إنذار الكائن ويعيد تسليحه عند غيابه. قد يتأخر التنظيف خلال هذا العطل، لكن فشل الجدولة لا يسمح بتوليد غير محدود.

### استهلاك SQLite — قياس محلي وتقدير للفوترة

قِيسَت قيم `SqlStorageCursor.rowsRead` و`rowsWritten` محلياً عبر Cloudflare Vitest/Miniflare لتنفيذ SQL نفسه:

- أول طلب من مفتاح غير موجود: lookup = 0 صف مقروء في القياس المحلي؛ upsert = 3 صفوف مكتوبة (صف الجدول + فهرس المفتاح الأساسي + فهرس `expires_at`).
- طلب مقبول لاحق للمفتاح نفسه: lookup = صف واحد مقروء، وupsert = صفان مكتوبان (صف الجدول وفهرس `expires_at`). تغيير العمود المفهرس `expires_at` يضيف كتابة فهرس في كل قبول.
- طلب مرفوض بعد الوصول للحد: صف واحد مقروء، وصفر صفوف مكتوبة.
- حذف سجل واحد: القياس المحلي أظهر صفين مقروءين، لكن مؤشر `rowsWritten` على cursor الحذف أظهر صفراً في Miniflare؛ لا أعتبر ذلك قياساً لفوترة Cloudflare. وثائق Cloudflare تنص أن الحذف يُحسب كتابة، وأن تحديث كل صف فهرس يُحسب كتابة إضافية؛ لذا تقدير الحذف هو 3 كتابات لكل سجل (الجدول وفهرسا المفتاح والانتهاء)، أي حتى نحو 1,500 كتابة لدفعة 500 سجل.

إذن كل طلب chat صالح يستخدم طلب Durable Object واحداً، وكل alarm invocation يُحسب طلباً واحداً أيضاً. وفق وثائق Cloudflare، كل `setAlarm()` يضيف صف كتابة واحداً؛ يشمل ذلك الجدولة الأولية وإعادة الجدولة بعد كل إنذار، وليس كل طلب chat. استعلام `SELECT changes()` في مسار التنظيف لم يُظهر قراءة أو كتابة صفوف في القياس المحلي. قياسات cursor المحلية لا تقيس زمن DO أو فوترة حساب الإنتاج؛ وDDL إنشاء الجدول/الفهارس قد يضيف كلفة تهيئة لم تُقَس هنا.

التقدير السابق «كتابة واحدة لكل طلب مقبول» كان غير دقيق. مع 100,000 صف كتابة مجاني يومياً، يكون الحد النظري نحو 50,000 طلب مقبول يومياً لمفاتيح موجودة (كتابتا صف لكل قبول)، أو نحو 33,333 طلباً إذا كان كل طلب لأول مرة من IP جديد (ثلاث كتابات). خمس طلبات لمفتاح جديد تكتب 11 صفاً إجمالاً، أي نحو 45,454 طلباً ضمن مجموعات من خمس، قبل خصم الإنذارات والتنظيف وأي استعمال آخر للحساب. هذه حدود حسابية تقريبية وليست توقعاً للمرور أو قياساً إنتاجياً؛ قد تكون حصة AI أو مدة DO أو موارد حساب Cloudflare الأخرى هي الحد السابق.

وفق وثائق Cloudflare التي راجعناها في 2026-10-31، حدود Durable Objects على Workers Free هي 100,000 طلب يومياً، و13,000 GB-s يومياً، و5 ملايين صف SQL مقروء يومياً، و100,000 صف مكتوب يومياً، و5 GB تخزين SQLite إجمالاً للحساب. توثّق صفحة الحدود أيضاً سقف 1 GB لكل SQLite Durable Object على Free. مع SQL الحالي، حد الصفوف المكتوبة قد يصبح أضيق من حد طلبات DO؛ وموارد الحساب المشتركة قد تقلل السعة الفعلية أكثر. بلوغ حد مجاني قد يجعل عمليات DO أو SQLite تفشل؛ عندها يفشل chat مغلقاً. هذه الحصص ليست بنية مجانية غير محدودة.

حصة Workers AI المجانية ما زالت 10,000 Neurons يومياً. حد IP لا يقيس Neurons ولا يحدها عالمياً: يمكن لعناوين كثيرة مختلفة تجاوز مجموع التوليد، وتختلف تكلفة كل prompt. حد Cloudflare AI هو الحد الصلب على مستوى المنصة، وKYAMI لا يضيف مقياساً دقيقاً أو سقفاً يومياً عاماً للـNeurons. يجب أن يظل الحساب على Workers Free بلا Pay As You Go أو وسيلة دفع.

المفتاح المشتق SHA-256 بيانات مستعارة الهوية (pseudonymous)، وليس مجهول الهوية؛ لا نخزّن رسائل المستخدم أو User-Agent أو عنوان IP الخام في Durable Object.

المراجع الرسمية: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)، [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)، [Durable Object exports وSQLite](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)، [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)، [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)، [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/).

خطة Workers AI المجانية الحالية تسمح بـ10,000 Neurons يومياً، وبعد استهلاكها ترفض Cloudflare الطلبات على خطة Workers Free. KYAMI يحوّل خطأ نفاد الحصة إلى `AI_QUOTA_EXHAUSTED` ويوضح أن الحد يُصفّر عند 00:00 UTC. لا نقيس Neurons لكل طلب ولا نقدّرها. إذا فشل الموديل أو نفدت الحصة، لا يوجد تحويل تلقائي إلى مزود مدفوع. يجب إبقاء حساب Cloudflare على الخطة المجانية؛ تغيير الحساب إلى خطة مدفوعة قد يجعل الاستخدام الزائد مدفوعاً.

مصادر Cloudflare الرسمية: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)، [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/)، [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)، [Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## CORS وترويسات الأمان

يسمح Worker بأصل Workers URL وأصل `https://kyamingu.github.io` الذي لا يزال مستخدماً للنسخة الثابتة. يتم رفض الأصول الأخرى، ويُسمح بطلبات بلا `Origin` لأن البرامج غير المتصفحية لا ترسل هذا الرأس غالباً؛ لذلك CORS ليس مصادقة.

تُضاف ترويسات CSP و`X-Content-Type-Options` و`X-Frame-Options` و`Referrer-Policy`. تسمح CSP بخطوط Google Fonts المستخدمة حالياً. تُستثنى ملفات الأسرار والتطوير والاختبار وملفات Worker الداخلية من الأصول العامة عبر `.assetsignore`.

## حدود الخطة المجانية

Workers Free لديها حالياً حد 100,000 طلب Worker يومياً، وWorkers AI لديها 10,000 Neurons يومياً. قد تفشل الطلبات عند بلوغ حدود الخطة. هذه الحصص مشتركة على مستوى حساب Cloudflare وقد تتأثر بتطبيقات أخرى في الحساب. لا يضمن KYAMI سعة أو وصولاً غير محدودين، ولا يفعّل Pay As You Go أو خطة مدفوعة.

## التطوير والاختبارات

المتطلبات: Node.js 20 أو أحدث وnpm.

```powershell
npm install
npm test
npm run assets:check
```

الاختبارات تستخدم Vitest وCloudflare Workers runtime المحلي لمحاكاة SQLite Durable Objects، وتستخدم `AI.run` وهمياً؛ لا تتصل بحساب الإنتاج ولا تستهلك حصة Workers AI. `npm run assets:check` يستخدم Wrangler بوضع `--dry-run` لفحص الحزمة والأصول محلياً؛ لا ينشر Worker ولا ينشئ namespace. تشغيل `wrangler dev` على إعدادات حقيقية مع استدعاء AI قد يتصل بحساب Cloudflare ويستهلك الحصة، لذلك لا ترسل طلب AI تجريبياً إلا إذا كنت تقصد استهلاك الحصة.

لمعاينة الملفات والمسارات محلياً من دون binding لـAI:

```powershell
npx wrangler dev --config wrangler.test.jsonc --local --ip 127.0.0.1 --port 8787
```

تأكد أن `/`, `/style.css`, `/app.js`, و`/config.js` متاحة، وأن `/src/index.js`, `/tests/worker.test.js`, `/server.js`, `/package.json`, `/wrangler.jsonc`, و`/.env` ترجع 404.

لتجربة الواجهة محلياً من دون AI، استخدم خادماً ثابتاً محلياً وافتح الواجهة؛ ستظهر حالة الاتصال إذا لم يتوفر Worker.

## النشر والإعداد

الإعداد الحالي في `wrangler.jsonc` يستخدم Worker `kyami-ai` وملفات المشروع كأصول، و`AI` و`ASSETS` كـ bindings. لا توجد أسرار مطلوبة في الواجهة. `config.js` يشير إلى Worker الحالي.

لم يتم النشر في هذه المرحلة. قبل أي نشر، راجع فرع `cloudflare-ai` ونتيجة الاختبارات وقائمة الأصول. أول نشر يعلن `exports` وينشئ namespace لـDurable Object؛ لا تستخدم أمر `wrangler deploy` إلا بعد موافقة منفصلة على النشر المقصود. لا تغيّر خطة Cloudflare أو إعدادات الإنتاج.

## الخصوصية والأمن والقيود

- لا ترسل كلمات مرور أو مفاتيح أو بيانات شخصية حساسة في المحادثات.
- لا توجد حسابات أو عزل محادثات بين مستخدمين؛ سجل المحادثة يبقى في متصفح المستخدم.
- محدد المعدل لكل IP دائم لكنه ليس حاجزاً عاماً ضد هجمات موزعة بمئات العناوين، ولا يشكل ميزانية Neurons عامة.
- نفاد حصة AI يوقف التوليد حتى إعادة التعيين اليومية في الخطة المجانية.
- لا توجد مصادر بحث أو اقتباسات، رفع ملفات، ذاكرة حساب، أو لوحة إدارة حالياً.
- ملفات إعدادات Render/Gemini القديمة لم تُحذف؛ لا تستخدمها كمسار نشر KYAMI الحالي.

### تجربة محلية يدوية

1. شغّل `npm test`؛ هذا يشغّل Cloudflare-compatible runtime محلياً مع SQLite حقيقية محلية وحصة AI وهمية.
2. شغّل `npm run assets:check` للتحقق من حزمة الأصول/الإعداد في وضع dry-run فقط.
3. لتجربة API محلية بلا binding لـAI استخدم أمر `wrangler dev` أعلاه. ستعمل الصحة والموديلات والأصول؛ يرفض chat المغلق إذا لم يتوفر binding للمحدد. لا تستخدم الاستدعاء لإجراء توليد AI مباشر.

### التراجع

التغييرات محلية على `cloudflare-ai` فقط. للتراجع عنها بعد مراجعة الفرق، أعد ملفات Phase 1.1 المعدلة إلى نسختها السابقة وأزل الملف الجديد `tests/durable-rate-limiter.test.js`. لا تتراجع إلى النسخة القديمة من محدد الذاكرة وتطلقها على الإنتاج بعد نشر هذه النسخة؛ يجب أن يبقى التراجع fail-closed أو يعاد تصميمه ونشره بموافقة. حذف namespace المنشأة بعد نشر مستقبلي يتطلب إجراء lifecycle مقصوداً في Wrangler وقد يحذف بياناتها نهائياً؛ لم يُنشأ namespace في هذه المرحلة.
