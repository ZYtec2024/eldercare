FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com

COPY . .
RUN sed -i 's/\r$//' entrypoint.sh

EXPOSE 5000

CMD ["sh", "entrypoint.sh"]
