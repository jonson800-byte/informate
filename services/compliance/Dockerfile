FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py engine.py rule_packs.py ./
COPY data ./data
USER nobody
EXPOSE 9100
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9100"]
