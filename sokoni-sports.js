/* ============================================================
   SOKONI SPORTS HUB — sokoni-sports.js
   window.SokoniSports IIFE module
   Teams · Players · Coaches · Venues · Tournaments · Marketplace · Community
============================================================ */
;(function(){
'use strict';

const _SPORTS_COLL = {
  teams:'teams', tournaments:'tournaments',
  players:'sportsPlayers', coaches:'sportsCoaches', venues:'sportsVenues',
  coach_bookings:'sportsCoachBookings', venue_bookings:'sportsVenueBookings',
  tn_registrations:'sportsTournamentRegs', posts:'sportsPosts',
  reviews:'sportsReviews', orders:'sportsOrders',
};
function _db(){ try{ return window.firebase?.firestore ? window.firebase.firestore() : null; }catch(e){ return null; } }
function fsWrite(col, data) {
  const fsCol = _SPORTS_COLL[col];
  if (fsCol) {
    try {
      const db = _db();
      if (db) db.collection(fsCol).doc(data.id).set(data, {merge:true}).catch(e => console.warn('[Sports] Firestore write:', col, e));
    } catch(e) {}
  }
  /* Always keep localStorage as offline cache / fallback */
  try {
    const key='spt_'+col; const arr=JSON.parse(localStorage.getItem(key)||'[]');
    const idx=arr.findIndex(x=>x.id===data.id);
    if(idx>-1) arr[idx]=data; else arr.unshift(data);
    localStorage.setItem(key, JSON.stringify(arr.slice(0,500)));
  } catch(e){}
}
function fsRead(col){ try{return JSON.parse(localStorage.getItem('spt_'+col)||'[]');}catch(e){return[];} }
function uid(){ try{return JSON.parse(localStorage.getItem('sokoniUser')||'{}').uid||'guest';}catch(e){return'guest';} }
function genId(pfx){ return pfx+Date.now()+Math.random().toString(36).slice(2,6); }

/* ── SPORT CATEGORIES ── */
const SPORT_CATEGORIES = [
  {id:'all',        label:'All Sports',    icon:'🏆', color:'#f59e0b'},
  {id:'football',   label:'Football',      icon:'⚽', color:'#22c55e'},
  {id:'basketball', label:'Basketball',    icon:'🏀', color:'#f97316'},
  {id:'rugby',      label:'Rugby',         icon:'🏉', color:'#8b5cf6'},
  {id:'athletics',  label:'Athletics',     icon:'🏃', color:'#06b6d4'},
  {id:'swimming',   label:'Swimming',      icon:'🏊', color:'#3b82f6'},
  {id:'boxing',     label:'Boxing / MMA',  icon:'🥊', color:'#ef4444'},
  {id:'volleyball', label:'Volleyball',    icon:'🏐', color:'#ec4899'},
  {id:'cricket',    label:'Cricket',       icon:'🏏', color:'#84cc16'},
  {id:'tennis',     label:'Tennis',        icon:'🎾', color:'#eab308'},
  {id:'golf',       label:'Golf',          icon:'⛳', color:'#10b981'},
  {id:'cycling',    label:'Cycling',       icon:'🚴', color:'#f59e0b'},
];

/* ── TEAMS ── */
const TEAMS = [
  {id:'tm001',name:'Nairobi Stars FC',sport:'football',league:'Nairobi Premier League',location:'Kasarani, Nairobi',county:'nairobi',founded:2008,members:25,icon:'⚽',color:'#ef4444',captain:'David Otieno',coach:'cch001',wins:18,losses:4,draws:6,goalsFor:54,goalsAgainst:22,description:'Top-flight football club based in Kasarani. Two-time Nairobi Premier League champions.',featured:true,rating:4.7,social:{whatsapp:'0712100001'},openToPlayers:true},
  {id:'tm002',name:'Coast United FC',sport:'football',league:'Mombasa Football League',location:'Mombasa CBD',county:'mombasa',founded:2011,members:22,icon:'⚽',color:'#3b82f6',captain:'Omar Hassan',coach:'cch002',wins:14,losses:7,draws:5,goalsFor:42,goalsAgainst:29,description:'Mombasa\'s most decorated football club. Known for fast attacking play.',featured:false,rating:4.4,openToPlayers:true},
  {id:'tm003',name:'Nairobi Suns Basketball',sport:'basketball',league:'KBF Premier League',location:'Westlands, Nairobi',county:'nairobi',founded:2014,members:15,icon:'🏀',color:'#f97316',captain:'Brian Kamau',coach:'cch004',wins:22,losses:8,draws:0,points:180,description:'Nairobi\'s premier basketball club. Multiple KBF championship finalists.',featured:true,rating:4.8,openToPlayers:false},
  {id:'tm004',name:'Nairobi Bulls Rugby',sport:'rugby',league:'Kenya Cup',location:'Upper Hill, Nairobi',county:'nairobi',founded:2006,members:35,icon:'🏉',color:'#8b5cf6',captain:'Kevin Ochieng',coach:'cch005',wins:12,losses:3,draws:2,points:74,description:'Kenya Cup regulars. Strong forward pack with explosive backline.',featured:false,rating:4.5,openToPlayers:true},
  {id:'tm005',name:'Rift Valley Harriers',sport:'athletics',league:'Athletics Kenya',location:'Eldoret',county:'uasin_gishu',founded:2003,members:40,icon:'🏃',color:'#06b6d4',captain:'Faith Chepkemoi',coach:'cch006',wins:0,losses:0,draws:0,description:'Elite athletics club producing national and international runners.',featured:true,rating:4.9,openToPlayers:true},
  {id:'tm006',name:'Sharks Swimming Club',sport:'swimming',league:'Kenya Swimming Federation',location:'Karen, Nairobi',county:'nairobi',founded:2010,members:28,icon:'🏊',color:'#3b82f6',captain:'Grace Wanjiku',coach:'cch007',wins:8,losses:2,draws:0,description:'Leading swimming club with Olympic-standard pool facilities.',featured:false,rating:4.6,openToPlayers:true},
  {id:'tm007',name:'Mombasa Spikers Volleyball',sport:'volleyball',league:'KVF Premier League',location:'Mombasa',county:'mombasa',founded:2012,members:18,icon:'🏐',color:'#ec4899',captain:'Aisha Mohamed',coach:'cch003',wins:16,losses:5,draws:0,description:'Women\'s volleyball powerhouse from the coast. Five-time county champions.',featured:false,rating:4.5,openToPlayers:false},
  {id:'tm008',name:'Westlands Cricket Club',sport:'cricket',league:'Nairobi Cricket League',location:'Westlands, Nairobi',county:'nairobi',founded:1998,members:20,icon:'🏏',color:'#84cc16',captain:'Raj Patel',coach:'cch008',wins:9,losses:3,draws:4,description:'One of Kenya\'s oldest cricket clubs with a strong youth academy.',featured:false,rating:4.3,openToPlayers:true},
];

/* ── PLAYERS ── */
const PLAYERS = [
  {id:'pl001',name:'David Otieno',sport:'football',team:'tm001',teamName:'Nairobi Stars FC',position:'Striker',age:24,nationality:'Kenyan',location:'Nairobi',icon:'⚽',stats:{goals:18,assists:7,matches:28,yellowCards:3,redCards:0},rating:4.8,featured:true,seeking:true,seekingType:'Professional contract',bio:'Prolific striker with exceptional pace and finishing. U20 national team capped.',achievements:['Top Scorer 2024','Player of Season 2023','U20 National Cap'],height:'1.78m',weight:'72kg',phone:'0712 201 001'},
  {id:'pl002',name:'Omar Hassan',sport:'football',team:'tm002',teamName:'Coast United FC',position:'Attacking Midfielder',age:22,nationality:'Kenyan',location:'Mombasa',icon:'⚽',stats:{goals:11,assists:14,matches:25,yellowCards:2,redCards:0},rating:4.6,featured:false,seeking:true,seekingType:'Club transfer',bio:'Creative midfielder with exceptional vision and passing range.',achievements:['Best Midfielder 2024'],height:'1.75m',weight:'68kg',phone:'0723 201 002'},
  {id:'pl003',name:'Brian Kamau',sport:'basketball',team:'tm003',teamName:'Nairobi Suns',position:'Point Guard',age:26,nationality:'Kenyan',location:'Nairobi',icon:'🏀',stats:{points:22.4,rebounds:5.1,assists:8.3,steals:2.1,matches:30},rating:4.9,featured:true,seeking:false,seekingType:'',bio:'Elite point guard with court vision. Team captain and KBF All-Star selection.',achievements:['KBF All-Star 2024','MVP 2023','Finals MVP 2022'],height:'1.88m',weight:'82kg',phone:'0734 201 003'},
  {id:'pl004',name:'Faith Chepkemoi',sport:'athletics',team:'tm005',teamName:'Rift Valley Harriers',position:'Long Distance Runner',age:21,nationality:'Kenyan',location:'Eldoret',icon:'🏃',stats:{pb_5k:'14:12',pb_10k:'30:01',pb_halfMarathon:'65:34',pb_marathon:'2:28:15'},rating:4.9,featured:true,seeking:true,seekingType:'International sponsorship',bio:'Sub-2:30 marathon runner. 2024 Nairobi Marathon champion. Kenya national team aspirant.',achievements:['Nairobi Marathon Champion 2024','East Africa 10K Gold 2023'],height:'1.61m',weight:'47kg',phone:'0745 201 004'},
  {id:'pl005',name:'Kevin Ochieng',sport:'rugby',team:'tm004',teamName:'Nairobi Bulls',position:'Flanker',age:28,nationality:'Kenyan',location:'Nairobi',icon:'🏉',stats:{tackles:87,tries:9,lineoutWins:34,matches:17},rating:4.6,featured:false,seeking:false,seekingType:'',bio:'Powerful flanker, cornerstone of Nairobi Bulls\' defence for 6 seasons.',achievements:['Kenya Cup Best Defender 2023'],height:'1.83m',weight:'95kg',phone:'0756 201 005'},
  {id:'pl006',name:'Grace Wanjiku',sport:'swimming',team:'tm006',teamName:'Sharks Swimming Club',position:'Freestyle Swimmer',age:19,nationality:'Kenyan',location:'Nairobi',icon:'🏊',stats:{pb_100m_free:'55.2s',pb_200m_free:'1:59.8',pb_400m_free:'4:15.3'},rating:4.7,featured:false,seeking:true,seekingType:'University scholarship',bio:'National 100m freestyle record holder. Commonwealth Games qualifier.',achievements:['National Record 100m Free 2024','Commonwealth qualifier'],height:'1.70m',weight:'58kg',phone:'0767 201 006'},
  {id:'pl007',name:'Aisha Mohamed',sport:'volleyball',team:'tm007',teamName:'Mombasa Spikers',position:'Outside Hitter',age:23,nationality:'Kenyan',location:'Mombasa',icon:'🏐',stats:{kills:4.2,digs:3.1,aces:0.8,blocks:0.5,matches:22},rating:4.5,featured:false,seeking:true,seekingType:'National team selection',bio:'Explosive outside hitter with strong service game. National team squad member.',achievements:['KVF Player of Season 2023'],height:'1.77m',weight:'65kg',phone:'0778 201 007'},
];

/* ── COACHES & TRAINERS ── */
const COACHES = [
  {id:'cch001',name:'Coach Peter Mwangi',sport:'football',type:'coach',location:'Nairobi',phone:'0712 300 001',email:'peter@sportskenya.co.ke',verified:true,rating:4.9,reviews:47,price:3000,priceUnit:'KES/session',sessionDuration:'90 min',specialties:['Tactics','Finishing','Youth Development'],experience:14,icon:'⚽',bio:'UEFA B License holder. Former professional player with 14 years coaching experience. Specializes in tactical development and attacking play.',certifications:['UEFA B License','Safeguarding Certificate','KPL Coaching Badge'],availability:['Mon','Tue','Wed','Thu','Fri'],teamId:'tm001'},
  {id:'cch002',name:'Coach Hassan Ali',sport:'football',type:'coach',location:'Mombasa',phone:'0723 300 002',email:'hassan@coastsports.co.ke',verified:true,rating:4.6,reviews:31,price:2500,priceUnit:'KES/session',sessionDuration:'90 min',specialties:['Set Pieces','Defensive Shape','Youth Coaching'],experience:9,icon:'⚽',bio:'FKF Licensed coach with strong background in youth football development. Coast region specialist.',certifications:['FKF A License'],availability:['Mon','Wed','Fri','Sat'],teamId:'tm002'},
  {id:'cch003',name:'Trainer Susan Njeri',sport:'volleyball',type:'trainer',location:'Mombasa',phone:'0734 300 003',email:'susan@mvclub.co.ke',verified:true,rating:4.7,reviews:28,price:2000,priceUnit:'KES/session',sessionDuration:'60 min',specialties:['Spiking','Serving','Team Play','Fitness'],experience:7,icon:'🏐',bio:'National level volleyball coach. Develops players from amateur to competitive level.',certifications:['FIVB Level 2','Physical Education Degree'],availability:['Tue','Thu','Sat','Sun'],teamId:'tm007'},
  {id:'cch004',name:'Coach John Kamau',sport:'basketball',type:'coach',location:'Nairobi',phone:'0745 300 004',email:'john@kbf.co.ke',verified:true,rating:4.8,reviews:52,price:3500,priceUnit:'KES/session',sessionDuration:'90 min',specialties:['Point Guard Training','Shooting','Basketball IQ'],experience:11,icon:'🏀',bio:'KBF certified coach. Former national team assistant. Develops complete players from grassroots.',certifications:['FIBA Level 2','Strength & Conditioning Cert'],availability:['Mon','Tue','Thu','Fri'],teamId:'tm003'},
  {id:'cch005',name:'Coach Michael Ochieng',sport:'rugby',type:'coach',location:'Nairobi',phone:'0756 300 005',email:'michael@kru.co.ke',verified:true,rating:4.5,reviews:22,price:2800,priceUnit:'KES/session',sessionDuration:'120 min',specialties:['Lineout','Scrum','Defensive Systems','7s Rugby'],experience:8,icon:'🏉',bio:'KRU accredited coach. Specialty in forwards and set piece. Coached in the Kenya Cup for 6 seasons.',certifications:['KRU Level 2','World Rugby Core Coaching'],availability:['Tue','Wed','Sat'],teamId:'tm004'},
  {id:'cch006',name:'Coach Samuel Kipchoge',sport:'athletics',type:'coach',location:'Eldoret',phone:'0767 300 006',email:'samuel@rvh.co.ke',verified:true,rating:4.9,reviews:63,price:1500,priceUnit:'KES/session',sessionDuration:'60 min',specialties:['Distance Running','Altitude Training','Race Strategy','Nutrition'],experience:18,icon:'🏃',bio:'Elite distance running coach. Has coached 3 Olympic athletes. Based in Eldoret\'s training heartland.',certifications:['Athletics Kenya Level 3','IAAF Level 2'],availability:['Mon','Tue','Wed','Thu','Fri','Sat'],teamId:'tm005'},
  {id:'cch007',name:'Trainer Mary Wangari',sport:'swimming',type:'trainer',location:'Nairobi',phone:'0778 300 007',email:'mary@sharksswim.co.ke',verified:false,rating:4.5,reviews:19,price:2500,priceUnit:'KES/session',sessionDuration:'60 min',specialties:['Freestyle','Butterfly','Starts & Turns','Youth Swimming'],experience:6,icon:'🏊',bio:'FINA certified swim instructor. Teaches beginners to competitive swimmers. Pool sessions available 6am–8pm.',certifications:['FINA Level 1','Lifeguard Certificate'],availability:['Mon','Wed','Thu','Sat','Sun'],teamId:'tm006'},
  {id:'cch008',name:'Personal Trainer Felix Maina',sport:'fitness',type:'trainer',location:'Nairobi',phone:'0789 300 008',email:'felix@fitkenya.co.ke',verified:true,rating:4.7,reviews:94,price:2000,priceUnit:'KES/session',sessionDuration:'60 min',specialties:['Strength Training','HIIT','Weight Loss','Sports Conditioning'],experience:5,icon:'💪',bio:'Certified personal trainer with sports conditioning specialty. Online and in-person sessions. Nutrition planning included.',certifications:['NASM CPT','CrossFit Level 1','Sports Nutrition Cert'],availability:['Mon','Tue','Wed','Thu','Fri','Sat'],teamId:null},
];

/* ── VENUES ── */
const VENUES = [
  {id:'vn001',name:'Kasarani Sports Complex',sports:['football','athletics','swimming'],location:'Kasarani, Nairobi',county:'nairobi',pricePerHour:5000,priceUnit:'KES/hr',capacity:60000,amenities:['parking','changing_rooms','floodlights','toilets','medical'],surfaces:['Natural grass','Synthetic track','Olympic pool'],rating:4.6,reviews:112,icon:'🏟️',verified:true,contact:'0712 400 001',featured:true,openTime:'06:00',closeTime:'22:00',description:'Kenya\'s premier sports venue. Multi-sport complex with FIFA-standard pitch, 400m athletics track and 50m Olympic pool.'},
  {id:'vn002',name:'City Park Football Ground',sports:['football'],location:'Parklands, Nairobi',county:'nairobi',pricePerHour:3000,priceUnit:'KES/hr',capacity:500,amenities:['parking','changing_rooms','floodlights','toilets'],surfaces:['Natural grass'],rating:4.4,reviews:67,icon:'⚽',verified:true,contact:'0723 400 002',featured:true,openTime:'07:00',closeTime:'21:00',description:'Well-maintained community football pitch in Parklands. Ideal for league matches and training sessions.'},
  {id:'vn003',name:'Westlands Basketball Arena',sports:['basketball','volleyball'],location:'Westlands, Nairobi',county:'nairobi',pricePerHour:2500,priceUnit:'KES/hr',capacity:200,amenities:['parking','changing_rooms','ac','toilets','scoreboard'],surfaces:['Hardwood court'],rating:4.7,reviews:43,icon:'🏀',verified:true,contact:'0734 400 003',featured:false,openTime:'07:00',closeTime:'22:00',description:'Indoor hardwood court suitable for basketball and volleyball. Air-conditioned with full scoreboard.'},
  {id:'vn004',name:'FitZone Premium Gym',sports:['fitness','boxing','mma'],location:'Kilimani, Nairobi',county:'nairobi',pricePerHour:1500,priceUnit:'KES/hr',capacity:80,amenities:['parking','shower','ac','locker','sauna'],surfaces:['Rubber matting','Boxing ring'],rating:4.8,reviews:156,icon:'💪',verified:true,contact:'0745 400 004',featured:true,openTime:'05:30',closeTime:'23:00',description:'Fully equipped gym with boxing ring, MMA cage, free weights, cardio equipment and recovery sauna.'},
  {id:'vn005',name:'Karen Swimming Centre',sports:['swimming'],location:'Karen, Nairobi',county:'nairobi',pricePerHour:2000,priceUnit:'KES/hr',capacity:40,amenities:['parking','changing_rooms','toilets','lifeguard'],surfaces:['25m indoor pool','50m outdoor pool'],rating:4.5,reviews:38,icon:'🏊',verified:false,contact:'0756 400 005',featured:false,openTime:'06:00',closeTime:'21:00',description:'Two-pool facility with indoor 25m and outdoor 50m competition pool. Professional lifeguards on duty.'},
  {id:'vn006',name:'Mombasa Beach Sports Park',sports:['football','volleyball','beach_volleyball'],location:'Nyali, Mombasa',county:'mombasa',pricePerHour:2000,priceUnit:'KES/hr',capacity:300,amenities:['toilets','changing_rooms'],surfaces:['Grass pitch','Sand volleyball court'],rating:4.3,reviews:29,icon:'🏖️',verified:false,contact:'0767 400 006',featured:false,openTime:'07:00',closeTime:'20:00',description:'Beachside sports facility with grass pitch and sand volleyball courts. Stunning ocean views.'},
  {id:'vn007',name:'Nakuru Athletics Track',sports:['athletics'],location:'Nakuru Town',county:'nakuru',pricePerHour:1000,priceUnit:'KES/hr',capacity:2000,amenities:['parking','toilets','changing_rooms'],surfaces:['400m synthetic track','Field events area'],rating:4.2,reviews:18,icon:'🏃',verified:true,contact:'0778 400 007',featured:false,openTime:'06:00',closeTime:'20:00',description:'IAAF certified 400m synthetic athletics track. Full field events areas including long jump, shot put, and high jump.'},
  {id:'vn008',name:'Rongai Multi-Sport Centre',sports:['football','basketball','tennis'],location:'Rongai, Kajiado',county:'kajiado',pricePerHour:1800,priceUnit:'KES/hr',capacity:400,amenities:['parking','changing_rooms','toilets','cafeteria'],surfaces:['Astroturf pitch','Basketball court','2 tennis courts'],rating:4.5,reviews:51,icon:'🎾',verified:true,contact:'0789 400 008',featured:false,openTime:'07:00',closeTime:'21:00',description:'Comprehensive community sports centre with astroturf football, basketball courts and tennis courts.'},
];

/* ── TOURNAMENTS ── */
const TOURNAMENTS = [
  {id:'tn001',name:'Nairobi Premier League 2026',sport:'football',organizer:'Nairobi Football Federation',status:'ongoing',startDate:'2026-01-15',endDate:'2026-07-30',teams:16,teamsRegistered:14,maxTeams:16,prizePool:500000,entryFee:15000,format:'Round Robin + Playoffs',location:'Various Nairobi Venues',icon:'⚽',featured:true,description:'The top tier football league in Nairobi. 16 teams compete over 7 months.',rounds:28,currentRound:12,registrationDeadline:'2026-01-10'},
  {id:'tn002',name:'KBF Under-25 Championship',sport:'basketball',organizer:'Kenya Basketball Federation',status:'upcoming',startDate:'2026-07-05',endDate:'2026-07-20',teams:8,teamsRegistered:5,maxTeams:8,prizePool:150000,entryFee:8000,format:'Group Stage + Knockout',location:'Westlands Arena, Nairobi',icon:'🏀',featured:true,description:'Under-25 basketball championship for emerging Kenyan talent.',rounds:null,currentRound:null,registrationDeadline:'2026-06-30'},
  {id:'tn003',name:'Kenya Cup Rugby 2026',sport:'rugby',organizer:'Kenya Rugby Union',status:'ongoing',startDate:'2026-02-01',endDate:'2026-05-15',teams:12,teamsRegistered:12,maxTeams:12,prizePool:300000,entryFee:20000,format:'Pool Stage + Knockout',location:'RFUEA Ground, Nairobi',icon:'🏉',featured:false,description:'Premier rugby union club competition in Kenya.',rounds:null,currentRound:8,registrationDeadline:'2026-01-20'},
  {id:'tn004',name:'Diani Beach Volleyball Classic',sport:'volleyball',organizer:'KVF Mombasa Branch',status:'upcoming',startDate:'2026-08-10',endDate:'2026-08-12',teams:16,teamsRegistered:9,maxTeams:16,prizePool:80000,entryFee:5000,format:'Pool Stage + Knockout',location:'Diani Beach, Kwale',icon:'🏐',featured:false,description:'Annual beach volleyball tournament on the beautiful Diani coast.',rounds:null,currentRound:null,registrationDeadline:'2026-08-01'},
  {id:'tn005',name:'Nairobi Corporate Cup 2026',sport:'football',organizer:'SOKONI Sports Events',status:'registration',startDate:'2026-09-06',endDate:'2026-09-07',teams:16,teamsRegistered:7,maxTeams:16,prizePool:100000,entryFee:10000,format:'Group + Knockout (1 day)',location:'City Park Ground, Nairobi',icon:'⚽',featured:true,description:'Annual corporate football tournament. 7-a-side format. Great networking and competitive fun.',rounds:null,currentRound:null,registrationDeadline:'2026-08-30'},
  {id:'tn006',name:'East Africa Athletics Trials',sport:'athletics',organizer:'Athletics Kenya',status:'upcoming',startDate:'2026-07-25',endDate:'2026-07-26',teams:0,teamsRegistered:0,maxTeams:0,prizePool:200000,entryFee:2000,format:'Individual Time Trials',location:'Kasarani, Nairobi',icon:'🏃',featured:true,description:'National athletics trials for East Africa Games selection. Open to all Athletics Kenya registered athletes.',rounds:null,currentRound:null,registrationDeadline:'2026-07-15'},
];

/* ── FIXTURES ── */
const FIXTURES_SEED = [
  {id:'fx001',tournamentId:'tn001',round:12,homeTeam:'tm001',homeName:'Nairobi Stars FC',awayTeam:'tm002',awayName:'Coast United FC',date:'2026-06-18',time:'15:00',venue:'City Park Ground',status:'upcoming',homeScore:null,awayScore:null},
  {id:'fx002',tournamentId:'tn001',round:11,homeTeam:'tm002',homeName:'Coast United FC',awayTeam:'tm001',awayName:'Nairobi Stars FC',date:'2026-06-10',time:'16:00',venue:'Mombasa Beach Sports Park',status:'completed',homeScore:1,awayScore:2},
  {id:'fx003',tournamentId:'tn001',round:10,homeTeam:'tm001',homeName:'Nairobi Stars FC',awayTeam:'tm008',awayName:'Westlands CC',date:'2026-06-03',time:'15:00',venue:'City Park Ground',status:'completed',homeScore:3,awayScore:0},
];

/* ── STANDINGS SEED ── */
const STANDINGS_SEED = {
  tn001: [
    {teamId:'tm001',teamName:'Nairobi Stars FC',played:12,won:9,drawn:2,lost:1,gf:28,ga:8,gd:20,points:29,form:['W','W','D','W','W']},
    {teamId:'tm002',teamName:'Coast United FC',played:12,won:7,drawn:3,lost:2,gf:22,ga:14,gd:8,points:24,form:['L','W','W','D','W']},
    {teamId:'tm008',teamName:'Westlands FC',played:11,won:5,drawn:3,lost:3,gf:17,ga:16,gd:1,points:18,form:['L','D','W','L','W']},
    {teamId:'tm_x1',teamName:'City Blazers FC',played:12,won:4,drawn:4,lost:4,gf:14,ga:18,gd:-4,points:16,form:['W','L','D','D','L']},
  ],
};

/* ── MARKETPLACE ── */
const MARKETPLACE_ITEMS = [
  {id:'mp001',name:'Pro Football Boots — Astroturf',sport:'football',brand:'SportZone KE',price:5500,condition:'new',seller:'SportZone Kenya',icon:'👟',rating:4.5,reviews:34,description:'High-quality astroturf football boots. Sizes 37–47 available.',category:'footwear'},
  {id:'mp002',name:'Club Training Jersey Set (10 pcs)',sport:'football',brand:'ProKit Africa',price:12000,condition:'new',seller:'ProKit Africa',icon:'👕',rating:4.6,reviews:18,description:'Custom team jerseys with printing included. Quick turnaround 5-7 days.',category:'apparel'},
  {id:'mp003',name:'Spalding Basketball (Official)',sport:'basketball',brand:'Spalding',price:4200,condition:'new',seller:'Sports Direct KE',icon:'🏀',rating:4.8,reviews:51,description:'Spalding NBA replica basketball. Composite leather, indoor/outdoor use.',category:'equipment'},
  {id:'mp004',name:'Professional Boxing Gloves 12oz',sport:'boxing',brand:'Venum',price:6800,condition:'new',seller:'Fighter\'s Den',icon:'🥊',rating:4.7,reviews:27,description:'Venum Challenger 2.0 boxing gloves. Triple density foam padding.',category:'equipment'},
  {id:'mp005',name:'Running Shoes — Long Distance',sport:'athletics',brand:'Nike KE',price:8900,condition:'new',seller:'Nike Kenya',icon:'👟',rating:4.9,reviews:78,description:'Nike Pegasus 41. Ideal for long distance training and racing. Sizes 36–47.',category:'footwear'},
  {id:'mp006',name:'Rugby Headguard & Mouthguard Set',sport:'rugby',brand:'Canterbury',price:3200,condition:'new',seller:'Rugby Store KE',icon:'🏉',rating:4.5,reviews:12,description:'Canterbury rugby headguard and mouthguard combo. Approved for competitive play.',category:'protective'},
  {id:'mp007',name:'Competition Swimsuit — Women',sport:'swimming',brand:'Arena',price:5800,condition:'new',seller:'SwimGear KE',icon:'🏊',rating:4.6,reviews:22,description:'Arena PowerSkin swimsuit. Competition grade, chlorine resistant.',category:'apparel'},
  {id:'mp008',name:'Fitness Resistance Band Set (5 bands)',sport:'fitness',brand:'FitPro',price:1800,condition:'new',seller:'FitZone Store',icon:'💪',rating:4.4,reviews:43,description:'Set of 5 resistance bands from light to heavy. Perfect for home workouts and warm-up.',category:'equipment'},
  {id:'mp009',name:'Football Pitch Training Cones (20 pcs)',sport:'football',brand:'ProCoach',price:800,condition:'new',seller:'Coaches Corner KE',icon:'🚩',rating:4.3,reviews:31,description:'Bright orange training cones. Essential for drills, agility training and pitch marking.',category:'equipment'},
  {id:'mp010',name:'Team Trophy — 30cm Gold',sport:'all',brand:'Trophy World',price:2500,condition:'new',seller:'Trophy World KE',icon:'🏆',rating:4.8,reviews:16,description:'30cm gold-plated sports trophy. Engraving included. Ships in 3 days.',category:'awards'},
];

/* ── COMMUNITY POSTS ── */
const COMMUNITY_POSTS_SEED = [
  {id:'cp001',type:'announcement',author:'Nairobi Stars FC',sport:'football',content:'🏆 MATCH DAY! We take on Coast United FC this Saturday at City Park Ground. Kick-off 3PM. Come support the Stars! Entry FREE for kids under 12.',likes:34,comments:12,ts:Date.now()-3600000*2,icon:'⚽',teamId:'tm001'},
  {id:'cp002',type:'update',author:'KBF Official',sport:'basketball',content:'🏀 Registration for KBF Under-25 Championship is OPEN! 3 spots remaining. Entry fee KES 8,000. Contact us to register your team.',likes:28,comments:7,ts:Date.now()-3600000*5,icon:'🏀',teamId:null},
  {id:'cp003',type:'achievement',author:'Faith Chepkemoi',sport:'athletics',content:'🏃‍♀️ Just broke the Nairobi Half Marathon course record with a 65:34! A huge thank you to Coach Samuel and the Rift Valley Harriers family. On to bigger things! 🇰🇪',likes:156,comments:43,ts:Date.now()-3600000*8,icon:'🏃',teamId:'tm005'},
  {id:'cp004',type:'discussion',author:'Sports Fan Kenya',sport:'football',content:'Who do you think will win the Nairobi Premier League this season? Nairobi Stars are looking unstoppable with 9 wins from 12! Drop your predictions below 👇',likes:67,comments:89,ts:Date.now()-3600000*12,icon:'⚽',teamId:null},
  {id:'cp005',type:'marketplace',author:'SportZone Kenya',sport:'all',content:'🛒 NEW STOCK ALERT: Nike Pegasus 41 running shoes just arrived. Sizes 36–47 available. DM to order or visit our store in Westlands.',likes:23,comments:5,ts:Date.now()-3600000*20,icon:'👟',teamId:null},
];

/* ══ TEAM FUNCTIONS ══ */
function createTeam(data) {
  const id = genId('TM'); const team = {id,...data,members:1,wins:0,losses:0,draws:0,createdAt:Date.now(),createdBy:uid()};
  fsWrite('teams',team); return team;
}
function getTeams(filter) {
  let list = [...TEAMS,...fsRead('teams')];
  if(!filter) return list;
  if(filter.sport && filter.sport!=='all') list=list.filter(t=>t.sport===filter.sport);
  if(filter.county) list=list.filter(t=>t.county?.toLowerCase().includes(filter.county.toLowerCase()));
  if(filter.q){const q=filter.q.toLowerCase();list=list.filter(t=>(t.name+t.location+t.sport).toLowerCase().includes(q));}
  if(filter.openToPlayers) list=list.filter(t=>t.openToPlayers);
  return list;
}
function getTeamById(id){ return [...TEAMS,...fsRead('teams')].find(t=>t.id===id); }

/* ══ PLAYER FUNCTIONS ══ */
function createPlayer(data){ const id=genId('PL'); const p={id,...data,createdAt:Date.now(),uid:uid()}; fsWrite('players',p); return p; }
function getPlayers(filter){
  let list=[...PLAYERS,...fsRead('players')];
  if(!filter)return list;
  if(filter.sport&&filter.sport!=='all')list=list.filter(p=>p.sport===filter.sport);
  if(filter.seeking)list=list.filter(p=>p.seeking);
  if(filter.q){const q=filter.q.toLowerCase();list=list.filter(p=>(p.name+p.sport+p.position).toLowerCase().includes(q));}
  return list;
}
function getPlayerById(id){ return [...PLAYERS,...fsRead('players')].find(p=>p.id===id); }

/* ══ COACH FUNCTIONS ══ */
function getCoaches(filter){
  let list=[...COACHES,...fsRead('coaches')].map(c=>({...c, ratePerSession:c.ratePerSession??c.price}));
  if(!filter)return list;
  if(filter.sport&&filter.sport!=='all')list=list.filter(c=>c.sport===filter.sport||c.sport==='fitness');
  if(filter.q){const q=filter.q.toLowerCase();list=list.filter(c=>(c.name+c.sport+c.location).toLowerCase().includes(q));}
  if(filter.verified)list=list.filter(c=>c.verified);
  return list;
}
function getCoachById(id){
  const c=[...COACHES,...fsRead('coaches')].find(c=>c.id===id);
  return c?{...c, ratePerSession:c.ratePerSession??c.price}:undefined;
}

function bookCoach(data){
  const id=genId('CB'); const bk={id,...data,status:'pending',createdAt:Date.now(),uid:uid(),ref:'SOKCOACH'+Math.random().toString(36).slice(2,6).toUpperCase()};
  const arr=JSON.parse(localStorage.getItem('spt_coach_bookings')||'[]'); arr.unshift(bk);
  localStorage.setItem('spt_coach_bookings',JSON.stringify(arr.slice(0,200)));
  fsWrite('coach_bookings',bk);
  addNotification({type:'coaching',title:'Booking Submitted',body:`Your coaching session with ${data.coachName} on ${data.date} has been submitted.`,ref:bk.ref});
  return bk;
}
function getCoachBookings(){ return JSON.parse(localStorage.getItem('spt_coach_bookings')||'[]').filter(b=>b.uid===uid()); }

/* ══ VENUE FUNCTIONS ══ */
function getVenues(filter){
  let list=[...VENUES,...fsRead('venues')];
  if(!filter)return list;
  if(filter.sport&&filter.sport!=='all')list=list.filter(v=>v.sports.includes(filter.sport));
  if(filter.county)list=list.filter(v=>v.county?.toLowerCase().includes(filter.county.toLowerCase()));
  if(filter.q){const q=filter.q.toLowerCase();list=list.filter(v=>(v.name+v.location+(v.sports||[]).join(' ')).toLowerCase().includes(q));}
  return list;
}
function getVenueById(id){ return [...VENUES,...fsRead('venues')].find(v=>v.id===id); }

function bookVenue(data){
  const id=genId('VB'); const bk={id,...data,status:'pending',createdAt:Date.now(),uid:uid(),ref:'SOKVN'+Math.random().toString(36).slice(2,6).toUpperCase()};
  const arr=JSON.parse(localStorage.getItem('spt_venue_bookings')||'[]'); arr.unshift(bk);
  localStorage.setItem('spt_venue_bookings',JSON.stringify(arr.slice(0,200)));
  fsWrite('venue_bookings',bk);
  const slotRange=(bk.slots||[]).length?`${bk.slots[0]}–${bk.slots[bk.slots.length-1]}`:'selected slots';
  addNotification({type:'venue',title:'Venue Booked',body:`Booking for ${bk.date} (${slotRange}) submitted. Ref: ${bk.ref}`,ref:bk.ref});
  return bk;
}
function getVenueBookings(venueId){ const all=JSON.parse(localStorage.getItem('spt_venue_bookings')||'[]'); return venueId?all.filter(b=>b.venueId===venueId):all; }
function getUserVenueBookings(){ return JSON.parse(localStorage.getItem('spt_venue_bookings')||'[]').filter(b=>b.uid===uid()); }
/* Returns an array of booked hour strings (e.g. ['09:00','10:00']) for a given venue+date */
function checkVenueAvailability(venueId,date){
  const booked=getVenueBookings(venueId).filter(b=>b.date===date&&b.status!=='cancelled');
  const hours=new Set();
  booked.forEach(b=>{if(Array.isArray(b.slots))b.slots.forEach(h=>hours.add(h));});
  return[...hours];
}

/* ══ TOURNAMENT FUNCTIONS ══ */
function getTournaments(filter){
  let list=[...TOURNAMENTS,...fsRead('tournaments')];
  if(!filter)return list;
  if(filter.sport&&filter.sport!=='all')list=list.filter(t=>t.sport===filter.sport);
  if(filter.status)list=list.filter(t=>t.status===filter.status);
  return list;
}
function getTournamentById(id){ return [...TOURNAMENTS,...fsRead('tournaments')].find(t=>t.id===id); }

function registerForTournament(data){
  const id=genId('TR'); const reg={id,...data,status:'pending',createdAt:Date.now(),uid:uid(),ref:'SOKTN'+Math.random().toString(36).slice(2,6).toUpperCase()};
  const arr=JSON.parse(localStorage.getItem('spt_tn_registrations')||'[]'); arr.unshift(reg);
  localStorage.setItem('spt_tn_registrations',JSON.stringify(arr.slice(0,200)));
  fsWrite('tn_registrations',reg);
  addNotification({type:'tournament',title:'Registration Submitted',body:`Your registration for ${data.tournamentName} has been submitted. Ref: ${reg.ref}`,ref:reg.ref});
  return reg;
}

function getFixtures(tournamentId){ const all=[...FIXTURES_SEED,...fsRead('fixtures')]; return tournamentId?all.filter(f=>f.tournamentId===tournamentId):all; }
function getStandings(tournamentId){ return STANDINGS_SEED[tournamentId]||fsRead('standings').filter(s=>s.tournamentId===tournamentId); }

/* ══ MARKETPLACE FUNCTIONS ══ */
function getMarketplace(filter){
  let list=[...MARKETPLACE_ITEMS,...fsRead('marketplace')];
  if(!filter)return list;
  if(filter.sport&&filter.sport!=='all')list=list.filter(i=>i.sport===filter.sport||i.sport==='all');
  if(filter.q){const q=filter.q.toLowerCase();list=list.filter(i=>(i.name+i.sport+i.brand).toLowerCase().includes(q));}
  return list;
}
function createOrder(item,qty,phone){
  const id=genId('MO'); const order={id,itemId:item.id,itemName:item.name,price:item.price,qty:qty||1,total:(item.price*(qty||1)),phone,status:'pending',createdAt:Date.now(),uid:uid(),ref:'SOKMKT'+Math.random().toString(36).slice(2,6).toUpperCase()};
  const arr=JSON.parse(localStorage.getItem('spt_orders')||'[]'); arr.unshift(order);
  localStorage.setItem('spt_orders',JSON.stringify(arr.slice(0,200)));
  fsWrite('orders',order);
  return order;
}

/* ══ COMMUNITY FUNCTIONS ══ */
function getPosts(filter){
  const extra=fsRead('posts'); let list=[...COMMUNITY_POSTS_SEED,...extra];
  if(filter?.sport&&filter.sport!=='all')list=list.filter(p=>p.sport===filter.sport||p.sport==='all');
  return list.sort((a,b)=>b.ts-a.ts);
}
function createPost(data){
  const id=genId('CP'); const p={id,...data,likes:0,comments:0,ts:Date.now(),uid:uid()};
  fsWrite('posts',p); return p;
}
function likePost(postId){
  const extra=fsRead('posts'); const idx=extra.findIndex(p=>p.id===postId);
  if(idx>-1){extra[idx].likes=(extra[idx].likes||0)+1;localStorage.setItem('spt_posts',JSON.stringify(extra));}
}

/* ══ REVIEWS ══ */
function addReview(targetId,targetType,data){
  const key='spt_rv_'+targetId; const arr=JSON.parse(localStorage.getItem(key)||'[]');
  arr.unshift({id:'RV'+Date.now(),...data,targetId,targetType,ts:Date.now(),uid:uid()});
  localStorage.setItem(key,JSON.stringify(arr.slice(0,30))); fsWrite('reviews',{targetId,targetType,...data,ts:Date.now()});
}
function getReviews(targetId){ return JSON.parse(localStorage.getItem('spt_rv_'+targetId)||'[]'); }
function getAvgRating(targetId,base){ const arr=getReviews(targetId); if(!arr.length)return base||4.5; return (arr.reduce((s,r)=>s+r.rating,0)/arr.length).toFixed(1); }

/* ══ SAVED ══ */
function saveItem(type,id){ const key='spt_saved_'+type+'_'+uid(); const arr=JSON.parse(localStorage.getItem(key)||'[]'); if(arr.includes(id)){localStorage.setItem(key,JSON.stringify(arr.filter(x=>x!==id)));return false;} arr.unshift(id);localStorage.setItem(key,JSON.stringify(arr.slice(0,100)));return true; }
function isSaved(type,id){ return JSON.parse(localStorage.getItem('spt_saved_'+type+'_'+uid())||'[]').includes(id); }

/* ══ NOTIFICATIONS ══ */
function addNotification(data){ const arr=JSON.parse(localStorage.getItem('spt_notifs')||'[]'); arr.unshift({id:'SN'+Date.now(),...data,ts:Date.now(),read:false}); localStorage.setItem('spt_notifs',JSON.stringify(arr.slice(0,100))); }
function getNotifications(){ return JSON.parse(localStorage.getItem('spt_notifs')||'[]'); }
function markNotifRead(id){ const arr=getNotifications().map(n=>n.id===id?{...n,read:true}:n); localStorage.setItem('spt_notifs',JSON.stringify(arr)); }
function getUnreadCount(){ return getNotifications().filter(n=>!n.read).length; }

/* ══ UTILS ══ */
function fmt(n){ return Number(n||0).toLocaleString('en-KE'); }
function timeSince(ts){ const d=Date.now()-ts; const m=Math.floor(d/60000); if(m<1)return'Just now'; if(m<60)return m+'m ago'; if(m<1440)return Math.floor(m/60)+'h ago'; return Math.floor(m/1440)+'d ago'; }
function starsHTML(r){ return[1,2,3,4,5].map(i=>`<span style="color:${i<=Math.round(r)?'#f59e0b':'rgba(255,255,255,0.15)'}">★</span>`).join(''); }
function sportColor(sport){ return SPORT_CATEGORIES.find(s=>s.id===sport)?.color||'#f59e0b'; }
function sportIcon(sport){ return SPORT_CATEGORIES.find(s=>s.id===sport)?.icon||'🏆'; }
function statusBadge(status){ const m={ongoing:{l:'Ongoing',c:'#22c55e'},upcoming:{l:'Upcoming',c:'#f59e0b'},registration:{l:'Registration Open',c:'#00aaff'},completed:{l:'Completed',c:'rgba(255,255,255,0.4)'},cancelled:{l:'Cancelled',c:'#ef4444'}}; return m[status]||{l:status,c:'white'}; }

/* ══ FIRESTORE USER SYNC ══
   Pulls the authenticated user's bookings/registrations from Firestore on page
   load so data is consistent across devices. Falls back silently if offline or
   firebase is not yet initialised. */
async function syncUserDataFromFirestore(){
  const userId=uid(); if(!userId||userId==='guest') return;
  try {
    const db=_db(); if(!db) return;
    const q=col=>db.collection(col).where('uid','==',userId).orderBy('createdAt','desc').limit(50).get();
    const[vnSnap,cbSnap,tnSnap]=await Promise.all([
      q('sportsVenueBookings').catch(()=>null),
      q('sportsCoachBookings').catch(()=>null),
      q('sportsTournamentRegs').catch(()=>null),
    ]);
    if(vnSnap&&!vnSnap.empty) localStorage.setItem('spt_venue_bookings',JSON.stringify(vnSnap.docs.map(d=>d.data())));
    if(cbSnap&&!cbSnap.empty) localStorage.setItem('spt_coach_bookings',JSON.stringify(cbSnap.docs.map(d=>d.data())));
    if(tnSnap&&!tnSnap.empty) localStorage.setItem('spt_tn_registrations',JSON.stringify(tnSnap.docs.map(d=>d.data())));
  } catch(e){ console.warn('[Sports] Sync from Firestore failed:',e); }
}

/* ── PUBLIC API ── */
window.SokoniSports = {
  SPORT_CATEGORIES, TEAMS, PLAYERS, COACHES, VENUES, TOURNAMENTS, MARKETPLACE_ITEMS, COMMUNITY_POSTS_SEED,
  createTeam, getTeams, getTeamById,
  createPlayer, getPlayers, getPlayerById,
  getCoaches, getCoachById, bookCoach, getCoachBookings,
  getVenues, getVenueById, bookVenue, getVenueBookings, getUserVenueBookings, checkVenueAvailability,
  getTournaments, getTournamentById, registerForTournament, getFixtures, getStandings,
  getMarketplace, createOrder,
  getPosts, createPost, likePost,
  addReview, getReviews, getAvgRating,
  saveItem, isSaved,
  addNotification, getNotifications, markNotifRead, getUnreadCount,
  syncUserDataFromFirestore,
  fmt, timeSince, starsHTML, sportColor, sportIcon, statusBadge,
};
})();
