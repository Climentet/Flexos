# Reto de Ejercicios

Aplicación Node.js para llevar el ranking de abdominales y flexiones.

## Modo Supabase

1. Crea un proyecto gratis en Supabase.
2. Abre el editor SQL y ejecuta el contenido de [supabase.sql](supabase.sql).
3. Copia la cadena de conexión en `DATABASE_URL`.
4. Sube este proyecto a un hosting de Node.js como Render o Railway.

Variables de entorno recomendadas:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres
SESSION_SECRET=una_clave_larga
CHALLENGE_PASSWORD=Makrichonda
```

## Desarrollo local

Si no defines `DATABASE_URL`, la app usa `data.db` con SQLite para desarrollo local.

```powershell
npm install
npm start
```

## Archivos clave

- [server.js](server.js#L1) - backend con Supabase/Postgres y fallback local.
- [supabase.sql](supabase.sql#L1) - tabla para pegar en el SQL editor.
- [.env.example](.env.example#L1) - variables de entorno de ejemplo.
