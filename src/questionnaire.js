// Onboarding questionnaire (shown in LIFF, validated here). Bilingual: [English, Thai].
// Types: number, text, choice (one), multi (several), yesno, time, scale (1-5).

export const QUESTIONNAIRE_VERSION = 1;

const yn = { type: "yesno" };
export const SECTIONS = [
  { id: "about", title: ["About you", "เกี่ยวกับคุณ"], questions: [
    { id: "name", type: "text", required: true, label: ["What should the coach call you?", "อยากให้โค้ชเรียกคุณว่าอะไร"] },
    { id: "age", type: "number", min: 12, max: 100, required: true, label: ["Age", "อายุ"] },
    { id: "sex", type: "choice", options: [["male", "Male", "ชาย"], ["female", "Female", "หญิง"], ["other", "Prefer not to say", "ไม่ระบุ"]], label: ["Sex", "เพศ"] },
    { id: "height", type: "number", min: 100, max: 230, unit: "cm", required: true, label: ["Height (cm)", "ส่วนสูง (ซม.)"] },
    { id: "weight", type: "number", min: 30, max: 250, unit: "kg", required: true, label: ["Weight (kg)", "น้ำหนัก (กก.)"] },
    { id: "waist", type: "number", min: 40, max: 200, unit: "cm", label: ["Waist (cm, optional)", "รอบเอว (ซม. ไม่บังคับ)"] },
  ] },
  { id: "goals", title: ["Goals", "เป้าหมาย"], questions: [
    { id: "goals", type: "multi", max: 2, required: true, label: ["Your top 1-2 goals", "เป้าหมายหลัก 1-2 ข้อ"], options: [
      ["lose_weight", "Lose weight", "ลดน้ำหนัก"], ["fitness", "Get fitter", "ฟิตขึ้น"], ["strength", "Build strength", "เพิ่มความแข็งแรง"],
      ["golf", "Improve my golf", "พัฒนากอล์ฟ"], ["sleep", "Sleep better", "นอนหลับดีขึ้น"], ["stress", "Less stress", "ลดความเครียด"],
      ["condition", "Manage a health condition", "ดูแลโรคประจำตัว"], ["mobility", "Move without pain", "เคลื่อนไหวคล่องไม่ปวด"]] },
    { id: "target", type: "text", label: ["A target, if you have one (e.g. lose 6 kg by March)", "เป้าที่ชัดเจน ถ้ามี (เช่น ลด 6 กก. ภายในมีนาคม)"] },
  ] },
  { id: "health", title: ["Health check", "ตรวจสุขภาพเบื้องต้น"], note: ["Standard pre-exercise screening (PAR-Q). Answer honestly - it keeps the plan safe.", "แบบคัดกรองก่อนออกกำลังกาย (PAR-Q) ตอบตามจริงเพื่อความปลอดภัย"], questions: [
    { id: "heart", ...yn, flag: "heart", label: ["Has a doctor ever said you have a heart condition?", "แพทย์เคยบอกว่าคุณมีปัญหาหัวใจหรือไม่"] },
    { id: "chest_pain", ...yn, flag: "chest_pain", label: ["Do you get chest pain when active or at rest?", "มีอาการเจ็บหน้าอกขณะออกแรงหรือพักหรือไม่"] },
    { id: "dizzy", ...yn, flag: "dizziness", label: ["Do you lose balance from dizziness or ever faint?", "เวียนศีรษะจนเสียการทรงตัวหรือเคยเป็นลมหรือไม่"] },
    { id: "bp_meds", ...yn, flag: "blood_pressure", label: ["Do you take medicine for blood pressure or the heart?", "ทานยาความดันหรือยาหัวใจหรือไม่"] },
    { id: "joints", ...yn, flag: "joints", label: ["Bone or joint problems that exercise could make worse?", "มีปัญหากระดูกหรือข้อที่อาจแย่ลงเมื่อออกกำลังกายหรือไม่"] },
    { id: "pregnant", ...yn, flag: "pregnancy", label: ["Are you pregnant or recently gave birth?", "ตั้งครรภ์หรือเพิ่งคลอดหรือไม่"] },
    { id: "conditions", type: "multi", label: ["Other conditions", "โรคประจำตัวอื่น"], flagAny: true, options: [
      ["gout", "Gout / high uric acid", "เกาต์ / กรดยูริกสูง"], ["diabetes", "Diabetes", "เบาหวาน"], ["asthma", "Asthma", "หอบหืด"],
      ["back", "Back pain", "ปวดหลัง"], ["knee", "Knee pain", "ปวดเข่า"], ["shoulder", "Shoulder pain", "ปวดไหล่"], ["other", "Other", "อื่น ๆ"]] },
    { id: "health_notes", type: "text", label: ["Anything else (injuries, surgery, medicines)?", "อื่น ๆ (อาการบาดเจ็บ ผ่าตัด ยาที่ทาน)"] },
  ] },
  { id: "activity", title: ["Activity now", "กิจกรรมตอนนี้"], questions: [
    { id: "exercise_days", type: "choice", required: true, label: ["Exercise days per week now", "ออกกำลังกายกี่วันต่อสัปดาห์ตอนนี้"], options: [["0", "0", "0"], ["1-2", "1-2", "1-2"], ["3-4", "3-4", "3-4"], ["5+", "5+", "5+"]] },
    { id: "activities", type: "multi", label: ["What do you do now?", "ตอนนี้ทำอะไรบ้าง"], options: [
      ["gym", "Gym / weights", "ยิม / เวท"], ["run", "Running", "วิ่ง"], ["walk", "Walking", "เดิน"], ["swim", "Swimming", "ว่ายน้ำ"],
      ["bike", "Cycling", "ปั่นจักรยาน"], ["yoga", "Yoga / Pilates", "โยคะ / พิลาทิส"], ["sport", "Team / racket sport", "กีฬาทีม / แร็กเก็ต"], ["none", "Nothing yet", "ยังไม่ได้ทำ"]] },
    { id: "fitness", type: "scale", required: true, label: ["Fitness level (1 low - 5 high)", "ระดับความฟิต (1 ต่ำ - 5 สูง)"] },
  ] },
  { id: "time", title: ["Time and place", "เวลาและสถานที่"], questions: [
    { id: "days", type: "multi", required: true, label: ["Days you can train", "วันที่ออกกำลังกายได้"], options: [
      ["1", "Mon", "จ."], ["2", "Tue", "อ."], ["3", "Wed", "พ."], ["4", "Thu", "พฤ."], ["5", "Fri", "ศ."], ["6", "Sat", "ส."], ["0", "Sun", "อา."]] },
    { id: "minutes", type: "choice", required: true, label: ["Minutes per session", "เวลาต่อครั้ง (นาที)"], options: [["20", "20", "20"], ["30", "30", "30"], ["45", "45", "45"], ["60", "60", "60"], ["90", "90+", "90+"]] },
    { id: "when", type: "choice", label: ["Best time", "ช่วงเวลาที่สะดวก"], options: [["morning", "Morning", "เช้า"], ["evening", "Evening", "เย็น"], ["either", "Either", "ได้ทั้งสอง"]] },
    { id: "places", type: "multi", label: ["Where can you train?", "ออกกำลังกายที่ไหนได้"], options: [
      ["gym", "Gym", "ยิม"], ["pool", "Pool", "สระว่ายน้ำ"], ["home", "Home", "บ้าน"], ["outdoor", "Outdoors / park", "กลางแจ้ง / สวน"], ["studio", "Pilates / yoga studio", "สตูดิโอพิลาทิส / โยคะ"]] },
    { id: "equipment", type: "text", label: ["Equipment you have (e.g. dumbbells, bands)", "อุปกรณ์ที่มี (เช่น ดัมเบล ยางยืด)"] },
  ] },
  { id: "habits", title: ["Habits", "นิสัยประจำวัน"], questions: [
    { id: "bedtime", type: "time", required: true, label: ["Usual bedtime", "เวลาเข้านอนปกติ"] },
    { id: "waketime", type: "time", required: true, label: ["Usual wake time", "เวลาตื่นปกติ"] },
    { id: "sleep_quality", type: "scale", label: ["Sleep quality (1 poor - 5 great)", "คุณภาพการนอน (1 แย่ - 5 ดีมาก)"] },
    { id: "drink_nights", type: "choice", required: true, label: ["Nights with alcohol per week", "ดื่มแอลกอฮอล์กี่คืนต่อสัปดาห์"], options: [["0", "0", "0"], ["1-2", "1-2", "1-2"], ["3-4", "3-4", "3-4"], ["5+", "5+", "5+"]] },
    { id: "water", type: "choice", label: ["Water per day", "ดื่มน้ำต่อวัน"], options: [["<1", "Under 1 L", "ไม่ถึง 1 ลิตร"], ["1-2", "1-2 L", "1-2 ลิตร"], ["2+", "Over 2 L", "มากกว่า 2 ลิตร"]] },
    { id: "screens", type: "choice", label: ["Screens in bed at night", "ใช้มือถือ/จอบนเตียงตอนกลางคืน"], options: [["rarely", "Rarely", "แทบไม่"], ["sometimes", "Sometimes", "บางครั้ง"], ["most", "Most nights", "เกือบทุกคืน"]] },
    { id: "diet", type: "text", label: ["Food notes (e.g. vegetarian, skip breakfast)", "เรื่องอาหาร (เช่น มังสวิรัติ ไม่ทานมื้อเช้า)"] },
  ] },
  { id: "golf", title: ["Golf", "กอล์ฟ"], questions: [
    { id: "plays_golf", ...yn, required: true, label: ["Do you play golf?", "คุณเล่นกอล์ฟหรือไม่"] },
    { id: "handicap", type: "text", showIf: "plays_golf", label: ["Handicap or usual score", "แฮนดิแคป หรือสกอร์ปกติ"] },
    { id: "rounds_month", type: "choice", showIf: "plays_golf", label: ["Rounds per month", "ออกรอบต่อเดือน"], options: [["0-1", "0-1", "0-1"], ["2-3", "2-3", "2-3"], ["4+", "4+", "4+"]] },
    { id: "practice", type: "multi", showIf: "plays_golf", label: ["Practice you can use", "สถานที่ซ้อมที่ใช้ได้"], options: [
      ["range", "Driving range", "สนามไดร์ฟ"], ["sim", "Simulator / launch monitor", "ซิมูเลเตอร์ / launch monitor"], ["putting", "Putting green", "กรีนพัตต์"], ["course", "Course", "สนาม"]] },
    { id: "weakness", type: "text", showIf: "plays_golf", label: ["Biggest weakness in your game", "จุดอ่อนที่สุดในเกม"] },
  ] },
  { id: "style", title: ["Coaching style", "สไตล์การโค้ช"], questions: [
    { id: "strictness", type: "scale", label: ["How strict? (1 gentle - 5 push me)", "เข้มงวดแค่ไหน (1 สบาย ๆ - 5 ผลักดันเต็มที่)"] },
    { id: "lang", type: "choice", required: true, label: ["Language", "ภาษา"], options: [["th", "ไทย", "ไทย"], ["en", "English", "English"]] },
  ] },
];

const ALL = SECTIONS.flatMap(s => s.questions);

/** Validates and normalises answers. Returns { answers, errors }. */
export function cleanAnswers(raw) {
  const out = {}, errors = [];
  const a = raw && typeof raw === "object" ? raw : {};
  for (const q of ALL) {
    if (q.showIf && a[q.showIf] !== true) continue;
    let v = a[q.id];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (empty) { if (q.required) errors.push(`${q.id} is required`); continue; }
    if (q.type === "number") {
      v = Number(v);
      if (!Number.isFinite(v) || v < q.min || v > q.max) { errors.push(`${q.id} must be ${q.min}-${q.max}`); continue; }
    } else if (q.type === "scale") {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 5) { errors.push(`${q.id} must be 1-5`); continue; }
    } else if (q.type === "yesno") {
      v = v === true || v === "yes" || v === "true";
    } else if (q.type === "choice") {
      if (!q.options.some(o => o[0] === v)) { errors.push(`${q.id}: unknown option`); continue; }
    } else if (q.type === "multi") {
      v = [].concat(v).filter(x => q.options.some(o => o[0] === x));
      if (q.max) v = v.slice(0, q.max);
      if (!v.length) { if (q.required) errors.push(`${q.id} is required`); continue; }
    } else if (q.type === "time") {
      if (!/^\d{2}:\d{2}$/.test(String(v))) { errors.push(`${q.id} must be HH:MM`); continue; }
    } else {
      v = String(v).trim().slice(0, 500);
    }
    out[q.id] = v;
  }
  return { answers: out, errors };
}

/** Health flags for the program designer and the admin portal. */
export function healthFlags(answers) {
  const flags = [];
  for (const q of ALL) {
    if (q.flag && answers[q.id] === true) flags.push(q.flag);
    if (q.flagAny && Array.isArray(answers[q.id])) flags.push(...answers[q.id]);
  }
  if (answers.age >= 65) flags.push("age_65_plus");
  if (answers.height && answers.weight) {
    const bmi = answers.weight / (answers.height / 100) ** 2;
    if (bmi >= 30) flags.push("bmi_30_plus");
  }
  return [...new Set(flags)];
}
