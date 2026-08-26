FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN chmod +x mvnw && ./mvnw dependency:resolve
COPY src/ src/
RUN ./mvnw package -DskipTests

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080

# Tuned for Render's 512 MB free instance, where cold-start time dominates.
#   TieredStopAtLevel=1  stop at the C1 JIT; skipping C2 cuts warmup sharply
#   UseSerialGC          one small heap does not need G1's threads and setup
#   MaxRAMPercentage=70  leave headroom so the container is not OOM-killed
ENTRYPOINT ["java", "-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-XX:MaxRAMPercentage=70", "-Djava.security.egd=file:/dev/urandom", "-jar", "app.jar"]
