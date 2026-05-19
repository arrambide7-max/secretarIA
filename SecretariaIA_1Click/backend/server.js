
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('../frontend'));
app.use('/comprobantes', express.static('uploads'));
app.use('/calendario', express.static('calendars'));
app.use('/productos', express.static('productos'));

['uploads','calendars','productos'].forEach(d=>{if(!fs.existsSync(d)) fs.mkdirSync(d)});

const STRIPE_LINK = 'https://buy.stripe.com/dRmbJ2giG7MwffZ4UQ5sA01';
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_change';

const db = new sqlite3.Database('final.db');
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT, negocio TEXT, wa_token TEXT, wa_phone_id TEXT, config TEXT, subscription_end TEXT, active INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY, user_id INTEGER, tipo TEXT, titulo TEXT, fecha TEXT, monto REAL, cliente TEXT, comprobante TEXT, ics_path TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS productos (id INTEGER PRIMARY KEY, user_id INTEGER, nombre TEXT, precio REAL, imagen TEXT)`);
});

// Auth
app.post('/api/signup', async (req,res)=>{
  const {email,password,negocio} = req.body;
  const hash = await bcrypt.hash(password,10);
  db.run(`INSERT INTO users (email,password,negocio,config,active) VALUES (?,?,?, ?, 0)`,[email,hash,negocio,'{"productos":[],"anticipo":30,"horario":"10am-7pm","tono":"amable","auto":true}'], function(err){
    if(err) return res.status(400).json({error:'Email ya existe'});
    const token = jwt.sign({id:this.lastID}, JWT_SECRET);
    res.json({token, stripe_link: STRIPE_LINK});
  });
});

app.post('/api/login', (req,res)=>{
  const {email,password} = req.body;
  db.get('SELECT * FROM users WHERE email=?',[email], async (e,user)=>{
    if(!user) return res.status(400).json({error:'No existe'});
    const ok = await bcrypt.compare(password, user.password);
    if(!ok) return res.status(400).json({error:'Clave incorrecta'});
    const token = jwt.sign({id:user.id}, JWT_SECRET);
    const expired = !user.subscription_end || new Date(user.subscription_end) < new Date();
    res.json({token, active: user.active && !expired, subscription_end: user.subscription_end, stripe_link: STRIPE_LINK});
  });
});

// Webhook Stripe: después de pagar, Stripe redirige a /success?session_id=xxx&user_id=yyy
app.get('/api/stripe/success', (req,res)=>{
  const {user_id} = req.query;
  const end = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  db.run('UPDATE users SET active=1, subscription_end=? WHERE id=?',[end, user_id],()=>{
    res.redirect('/app.html?paid=1');
  });
});

function auth(req,res,next){
  const h = req.headers.authorization?.split(' ')[1];
  try{ 
    req.user = jwt.verify(h, JWT_SECRET); 
    db.get('SELECT active, subscription_end FROM users WHERE id=?',[req.user.id],(e,u)=>{
      if(!u.active || !u.subscription_end || new Date(u.subscription_end) < new Date()){
        return res.status(403).json({error:'Suscripción expirada', stripe_link: STRIPE_LINK});
      }
      next();
    });
  }catch{ res.status(401).end(); }
}

// Entrenamiento + productos con imagen
app.post('/api/train', auth, (req,res)=>{
  const {texto, imagenes} = req.body; // imagenes = [{nombre,precio,base64}]
  db.get('SELECT config FROM users WHERE id=?',[req.user.id],(e,u)=>{
    let cfg = JSON.parse(u.config);
    const prods=[...texto.matchAll(/([\w\s]+)\s*\$?(\d{2,5})/g)].map(m=>({nombre:m[1].trim(),precio:+m[2]}));
    if(prods.length) cfg.productos=prods;
    const ant=texto.match(/(\d{1,2})\s*%/); if(ant) cfg.anticipo=+ant[1];
    db.run('UPDATE users SET config=? WHERE id=?',[JSON.stringify(cfg), req.user.id]);
    
    if(imagenes){
      imagenes.forEach(img=>{
        const filename = `prod_${Date.now()}_${img.nombre}.png`;
        fs.writeFileSync(path.join('productos',filename), Buffer.from(img.base64,'base64'));
        db.run(`INSERT INTO productos (user_id,nombre,precio,imagen) VALUES (?,?,?,?)`,[req.user.id, img.nombre, img.precio, `/productos/${filename}`]);
      });
    }
    res.json(cfg);
  });
});

// Webhook WhatsApp - SOLO SI ACTIVO
app.post('/webhook/:userId', async (req,res)=>{
  const userId = req.params.userId;
  db.get('SELECT * FROM users WHERE id=?',[userId], async (e,user)=>{
    if(!user || !user.active || new Date(user.subscription_end) < new Date()) return res.sendStatus(200); // NO CONTESTA SI NO PAGÓ
    
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return res.sendStatus(200);
    const cfg = JSON.parse(user.config);
    const nombre = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name||'Cliente';
    let respuesta = '';
    
    if(msg.type==='image'){
      // comprobante
      const mediaId = msg.image.id;
      const mediaInfo = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`,{headers:{Authorization:`Bearer ${user.wa_token}`}}).catch(()=>null);
      if(mediaInfo){
        const img = await axios.get(mediaInfo.data.url,{headers:{Authorization:`Bearer ${user.wa_token}`},responseType:'arraybuffer'});
        const filename = `comp_${Date.now()}.jpg`;
        fs.writeFileSync(path.join('uploads',filename), img.data);
        const monto = (msg.image.caption||'').match(/(\d{3,5})/)?.[1] || cfg.productos[0]?.precio || 0;
        db.run(`INSERT INTO eventos (user_id,tipo,titulo,fecha,monto,cliente,comprobante) VALUES (?,?,?,?,?,?,?)`,
          [userId,'venta',`Pago ${nombre}`, new Date().toISOString(), monto, nombre, `/comprobantes/${filename}`]);
        respuesta = `¡Listo ${nombre}! Recibí tu comprobante por $${monto}. Pago registrado.`;
      }
    } else {
      const texto = msg.text?.body||'';
      // Cotización con imagen
      if(/cu[aá]nto|precio|cotiza/i.test(texto)){
        const prodMatch = cfg.productos.find(p=>texto.toLowerCase().includes(p.nombre.toLowerCase()));
        if(prodMatch){
          db.get('SELECT imagen FROM productos WHERE user_id=? AND nombre=?',[userId, prodMatch.nombre],(e,p)=>{
            respuesta = `${prodMatch.nombre} $${prodMatch.precio}. Anticipo ${cfg.anticipo}%.`;
            enviar(user, msg.from, respuesta, p?.imagen);
          });
          return res.sendStatus(200);
        }
      }
      respuesta = `Hola ${nombre}, ${cfg.productos[0]?.nombre||'servicio'} $${cfg.productos[0]?.precio||500}.`;
    }
    
    if(respuesta) enviar(user, msg.from, respuesta);
    res.sendStatus(200);
  });
});

async function enviar(user, to, texto, imagen=null){
  if(imagen){
    await axios.post(`https://graph.facebook.com/v20.0/${user.wa_phone_id}/messages`,{
      messaging_product:'whatsapp', to, type:'image', image:{link:`${process.env.BASE_URL}${imagen}`, caption:texto}
    },{headers:{Authorization:`Bearer ${user.wa_token}`}}).catch(()=>{});
  } else {
    await axios.post(`https://graph.facebook.com/v20.0/${user.wa_phone_id}/messages`,{
      messaging_product:'whatsapp', to, text:{body: texto}
    },{headers:{Authorization:`Bearer ${user.wa_token}`}}).catch(()=>{});
  }
}

app.get('/webhook/:userId',(req,res)=> res.send(req.query['hub.challenge']||'ok'));
app.get('/api/me', auth, (req,res)=> db.get('SELECT * FROM users WHERE id=?',[req.user.id],(e,u)=>res.json({...u,config:JSON.parse(u.config)})));
app.get('/api/productos', auth, (req,res)=> db.all('SELECT * FROM productos WHERE user_id=?',[req.user.id],(e,r)=>res.json(r)));
app.post('/api/connect-whatsapp', auth, (req,res)=>{
  const {wa_token, wa_phone_id} = req.body;
  db.run('UPDATE users SET wa_token=?, wa_phone_id=? WHERE id=?',[wa_token, wa_phone_id, req.user.id],()=>res.json({ok:true}));
});

app.listen(3000,()=>console.log('Final con pago'));
