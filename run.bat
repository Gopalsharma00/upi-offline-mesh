@echo off
echo ===================================================
echo   Starting Distributed UPI Mesh Demo
echo ===================================================

echo.
echo [1/2] Starting Docker Containers (PostgreSQL & Redis)...
docker-compose up -d

echo.
echo Waiting 5 seconds for databases to initialize...
timeout /t 5 /nobreak > NUL

echo.
echo [2/2] Starting Spring Boot Application...
:: Clear JAVA_HOME locally for this script to avoid path space issues, 
:: forcing Maven to use the 'java' executable found in your PATH.
set JAVA_HOME=
mvnw.cmd spring-boot:run
