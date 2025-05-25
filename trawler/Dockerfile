# Base Python image
FROM python:3.11-slim

# Install tzdata for timezone support
RUN apt-get update && \
    apt-get install -y tzdata && \
    rm -rf /var/lib/apt/lists/*

# Set the timezone environment variable
ENV TZ=Africa/Johannesburg

# Optional: Configure tzdata non-interactively
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Set working directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the app and .env file
COPY trawler.py .
#COPY .env .

# Run the application
CMD ["python", "trawler.py"]

