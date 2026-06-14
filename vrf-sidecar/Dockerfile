FROM python:3.12-slim

# LibreOffice headless — needed to recalculate xlsx formulas before delivery.
# The BOQ uses VLOOKUP/SUM formulas; without recalc, cached values are blank.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-calc \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY engine/ ./engine/

# Render/Railway injects $PORT. Bind to it.
ENV PORT=8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
