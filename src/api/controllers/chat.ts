import _ from "lodash";
import { PassThrough } from "stream";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { generateImages, generateImagesWithReference, uploadReferenceImage, DEFAULT_MODEL } from "./images.ts";

// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;

/**
 * 解析模型
 *
 * @param model 模型名称
 * @returns 模型信息
 */
function parseModel(model: string) {
  const [_model, size] = model.split(":");
  const [_, width, height] = /(\d+)[\W\w](\d+)/.exec(size) ?? [];
  return {
    model: _model,
    width: size ? Math.ceil(parseInt(width) / 2) * 2 : 1024,
    height: size ? Math.ceil(parseInt(height) / 2) * 2 : 1024,
  };
}

/**
 * 检查内容是否包含图片URL
 * 
 * @param content 消息内容
 * @returns 图片URL和剩余提示词
 */
async function parseImageContent(content: string): Promise<{ imageUrl?: string; prompt: string; blob?: Blob }> {
  const imageUrlMatch = content.match(/^(https?:\/\/[^\s]+\.(jpg|jpeg|png|webp))/i);
  if (!imageUrlMatch) {
    return { prompt: content };
  }

  const imageUrl = imageUrlMatch[0];
  const prompt = content.slice(imageUrl.length).trim();
  
  // 下载图片
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new APIException(EX.API_FILE_URL_INVALID, `无法下载图片: ${imageUrl}`);
  }
  
  const blob = await response.blob();
  return { imageUrl, prompt, blob };
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletion(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    if (messages.length === 0)
      throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "消息不能为空");

    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    const lastMessage = messages[messages.length - 1].content;
    const { imageUrl, prompt, blob } = await parseImageContent(lastMessage);

    let imageUrls;
    if (imageUrl && blob) {
      // 上传参考图片
      const referenceImageUri = await uploadReferenceImage(blob, refreshToken);
      // 使用参考图片生成
      imageUrls = await generateImagesWithReference(
        model,
        prompt,
        referenceImageUri,
        {
          width,
          height,
          sampleStrength: 0.5,
          referenceStrength: 0.5,
        },
        refreshToken
      );
    } else {
      // 普通生成
      imageUrls = await generateImages(
        model,
        prompt,
        {
          width,
          height,
        },
        refreshToken
      );
    }

    return {
      id: util.uuid(),
      model: _model || model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: imageUrls.reduce(
              (acc, url, i) => acc + `![image_${i}](${url})\n`,
              ""
            ),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(messages, refreshToken, _model, retryCount + 1);
      })();
    }
    throw err;
  });
}

/*
// 普通生成
await createCompletion([
  { role: "user", content: "生成一张猫的图片" }
], refreshToken);

// 使用参考图片生成
await createCompletion([
  { role: "user", content: "https://example.com/cat.jpg 生成一张类似的猫的图片" }
], refreshToken);
*/
/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletionStream(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    const stream = new PassThrough();

    if (messages.length === 0) {
      logger.warn("消息为空，返回空流");
      stream.end("data: [DONE]\n\n");
      return stream;
    }

    stream.write(
      "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model || model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "🎨 图像生成中，请稍候..." },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n"
    );

    const lastMessage = messages[messages.length - 1].content;
    const { imageUrl, prompt, blob } = await parseImageContent(lastMessage);

    let imagePromise;
    if (imageUrl && blob) {
      // 上传参考图片
      const referenceImageUri = await uploadReferenceImage(blob, refreshToken);
      // 使用参考图片生成
      imagePromise = generateImagesWithReference(
        model,
        prompt,
        referenceImageUri,
        {
          width,
          height,
          sampleStrength: 0.5,
          referenceStrength: 0.5,
        },
        refreshToken
      );
    } else {
      // 普通生成
      imagePromise = generateImages(
        model,
        prompt,
        { width, height },
        refreshToken
      );
    }

    imagePromise
      .then((imageUrls) => {
        for (let i = 0; i < imageUrls.length; i++) {
          const url = imageUrls[i];
          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: i + 1,
                    delta: {
                      role: "assistant",
                      content: `![image_${i}](${url})\n`,
                    },
                    finish_reason: i < imageUrls.length - 1 ? null : "stop",
                  },
                ],
              }) +
              "\n\n"
          );
        }
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: imageUrls.length + 1,
                  delta: {
                    role: "assistant",
                    content: "图像生成完成！",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
        );
        stream.end("data: [DONE]\n\n");
      })
      .catch((err) => {
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 1,
                  delta: {
                    role: "assistant",
                    content: `生成图片失败: ${err.message}`,
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
        );
        stream.end("data: [DONE]\n\n");
      });
    return stream;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          messages,
          refreshToken,
          _model,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}
