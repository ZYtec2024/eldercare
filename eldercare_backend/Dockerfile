FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

# 复制源码与启动脚本
COPY . .

RUN sed -i 's/\r$//' entrypoint.sh

EXPOSE 5000

CMD ["sh", "entrypoint.sh"]
