// 腾讯云语音评测（英文发音评测 soe）封装
// 仅在配置了 TENCENT_SECRET_ID / TENCENT_SECRET_KEY 时启用真实评测，
// 未配置时由调用方退回本地评分。
const tencentcloud = require('tencentcloud-sdk-nodejs');

const SECRET_ID = process.env.TENCENT_SECRET_ID;
const SECRET_KEY = process.env.TENCENT_SECRET_KEY;
const REGION = process.env.TENCENT_REGION || 'ap-guangzhou';

let client = null;
if (SECRET_ID && SECRET_KEY) {
  try {
    client = new tencentcloud.soe.v20180724.Client({
      credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
      region: REGION,
      profile: { httpProfile: { endpoint: 'soe.tencentcloudapi.com' } }
    });
    console.log('✅ 已启用腾讯云语音评测');
  } catch (e) {
    console.warn('⚠️ 腾讯云客户端初始化失败，将使用本地评分：', e.message);
    client = null;
  }
} else {
  console.log('ℹ️ 未配置腾讯云密钥，使用本地评分（设置 TENCENT_SECRET_ID/KEY 后自动启用真实评测）');
}

function isConfigured() { return !!client; }

// audioBase64: 音频 base64；refText: 参考英文文本；voiceFormat: 'wav' | 'opus'（前端录音格式）
async function assess(audioBase64, refText, voiceFormat) {
  if (!client) throw new Error('NOT_CONFIGURED');
  let fileType = 2, encodeType = 2; // 默认 wav(pcm)
  if (voiceFormat === 'opus') { fileType = 4; encodeType = 4; } // ogg-opus
  const resp = await client.DescribeSyncSpeechEvaluation({
    EngSerViceType: 1,       // 1: 英文句子
    VoiceFileType: fileType,
    VoiceEncodeType: encodeType,
    RefText: refText,
    TextMode: 0,             // 0: 普通文本
    ScoreCoeff: 1.0,
    UserVoiceData: audioBase64
  });
  const words = (resp.Words || []).map(w => ({
    word: w.Word,
    match: w.MatchTag,
    accuracy: w.PronAccuracy
  }));
  const transcript = words
    .filter(w => w.match === 1 || w.match === 2)
    .map(w => w.word)
    .join(' ');
  return {
    score: Math.round(resp.FinalScore || 0),
    accuracy: Math.round(resp.PronAccuracy || 0),
    fluency: Math.round(resp.PronFluency || 0),
    completeness: Math.round(resp.PronCompletion || 0),
    transcript,
    words
  };
}

module.exports = { isConfigured, assess };
