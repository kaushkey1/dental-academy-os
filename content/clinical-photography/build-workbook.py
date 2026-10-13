from pathlib import Path
import json, shutil
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((Path(__file__).parent/'course.json').read_text())
OUT = ROOT/'output/pdf/clinical-photography-workbook.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('DV', str(ROOT/'assets/fonts/DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('DVB', str(ROOT/'assets/fonts/DejaVuSans-Bold.ttf')))
W,H=595.28,841.89
BLUE=HexColor('#245AD4'); INK=HexColor('#182D4C'); MUTED=HexColor('#52647E'); PALE=HexColor('#EDF3FF'); LINE=HexColor('#D7E1EF')
c=canvas.Canvas(str(OUT),pagesize=(W,H)); c.setTitle('Clinical Photography Foundations - Practical Workbook'); c.setAuthor('Dental Academy OS - course review edition')
styles={
 'body':ParagraphStyle('body',fontName='DV',fontSize=10,leading=15,textColor=INK),
 'small':ParagraphStyle('small',fontName='DV',fontSize=8.4,leading=12.5,textColor=MUTED),
 'head':ParagraphStyle('head',fontName='DVB',fontSize=12,leading=17,textColor=INK),
}
def text(s,x,y,width=499,style='body'):
 p=Paragraph(s,styles[style]); _,h=p.wrap(width,1000); p.drawOn(c,x,y-h); return y-h

def page(n,section,title,subtitle):
 c.setFillColor(BLUE); c.rect(0,H-12,W,12,fill=1,stroke=0)
 c.setFillColor(MUTED);c.setFont('DVB',8); c.drawString(48,H-45,'CLINICAL PHOTOGRAPHY FOUNDATIONS')
 c.setFont('DV',8);c.drawRightString(W-48,H-45,'PRACTICAL WORKBOOK / REVIEW EDITION')
 c.setFillColor(BLUE);c.setFont('DVB',9);c.drawString(48,H-89,section.upper())
 y=H-109
 p=Paragraph(title,ParagraphStyle('title',fontName='DVB',fontSize=26,leading=32,textColor=INK));_,h=p.wrap(499,100);p.drawOn(c,48,y-h);y-=h+13
 y=text(subtitle,48,y,style='body')
 c.setStrokeColor(LINE);c.line(48,51,W-48,51)
 c.setFont('DV',8);c.setFillColor(MUTED);c.drawString(48,34,'MODEL-BASED PRACTICE  /  NO APPROVED EDUCATION CREDITS');c.drawRightString(W-48,34,f'{n:02d} / 09')
 return y-24

def box(label,y,height=64):
 c.setFillColor(PALE);c.roundRect(48,y-height,499,height,7,fill=1,stroke=0)
 text(label,61,y-10,473,'small');return y-height-12

def lines(label,y,count=3):
 y=text(label,48,y,style='head')-8
 c.setStrokeColor(LINE)
 for _ in range(count):
  c.line(48,y-20,547,y-20);y-=26
 return y-12

def table(rows,y,widths,heights=None):
 cells=[[Paragraph(str(v),styles['small']) for v in row] for row in rows]
 t=Table(cells,colWidths=widths,rowHeights=heights)
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),PALE),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.6,LINE),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
 _,h=t.wrap(499,1000);t.drawOn(c,48,y-h);return y-h-20

def end():c.showPage()

y=page(1,'Your field guide','A repeatable image.<br/>A useful record.','A practical companion to six modules, 12 lessons and a final assessment. Allow three to four hours with the exercises. Keep this workbook alongside the course player.')
y=box('START HERE: Work on a dental model, mannequin or other non-patient training subject. No patient images or identifying information belong in this workbook.',y,64)
y=text('What you will make',48,y,style='head')-13
for title,desc in [('01  A setup card','Record the camera, subject, lighting and geometry so another person can repeat the session.'),('02  A quality checklist','Find the cause of a weak image and choose one corrective action.'),('03  A five-view practice portfolio','Keep the originals, select a consistent series and explain one improvement.')]:
 y=text(title,48,y,style='head')-6;y=text(desc,48,y)-21
 y=max(y,0)
y=lines('Your name or training alias / practice date',y,1)
y=text('How to complete the course',48,y,style='head')-7
y=text('Read each lesson, perform its exercise and record your findings. Mark the lesson complete in the player. The final quiz has 16 questions, an 80% pass mark (at least 13 correct) and three attempts. Portfolio work is self-reviewed; the platform does not inspect or grade photographs.',48,y)-16
text('Review edition: academy clinical review, local policy approval and faculty attribution are pending. This course does not establish clinical competence or accredited continuing-education credit. Use qualified supervision and academy-approved procedures before applying a workflow with patients.',48,y,style='small');end()

y=page(2,'Modules 01-02','Build your setup card.','Make the session reproducible before trying to make the image beautiful. Use this sheet for every practice series.')
y=table([['FIELD','YOUR BASELINE'],['Training subject / intended view',''],['Camera / lens / focal length',''],['Exposure mode / ISO / aperture / shutter',''],['Light source / position / power',''],['White balance / reference / colour handling',''],['Camera position / working distance / framing',''],['Focus target / orientation / file format',''],['File destination / naming / original preservation','']],y,[207,292],[34]+[43]*8)
y=lines('What must stay fixed when you repeat this series?',y,2)
text('Record what you actually used. There is no single camera setting that fits every device, lens, light or subject. Test the setup on the model, then review the result at useful magnification.',48,y,style='small');end()

y=page(3,'Module 02','Change one variable.','Use a textured model or printed object. Fix the camera and subject position. Keep a starting frame, change one setting, then explain what changed.')
y=table([['FRAME / CHANGE','WHAT DID YOU OBSERVE?','NEXT ACTION'],['A / baseline','',''],['B / aperture','',''],['C / shutter or lighting','',''],['D / ISO','','']],y,[143,202,154],[36,65,65,65,65])
y=text('A useful sequence',48,y,style='head')-8
y=text('1. Check brightness without accepting clipped detail.<br/>2. Inspect the intended focus area and the depth of the subject.<br/>3. Check motion blur, noise and reflections separately.<br/>4. Retest one change and compare with the baseline.',48,y)-22
y=lines('Which adjustment solved the problem? What trade-off did it create?',y,3)
text('Aperture affects light and depth of field; shutter time affects ambient exposure and motion; ISO changes amplification and its trade-offs. Flash behaviour depends on the device and synchronisation settings. Consult the equipment manual and practise before a clinical session.',48,y,style='small');end()

y=page(4,'Module 03','Make comparisons fair.','Separate a change in the subject from a change in how the photograph was made. Use the sketch as a recording aid, not a prescribed lighting arrangement.')
c.setFillColor(PALE);c.roundRect(48,y-187,499,187,8,fill=1,stroke=0)
cy=y-104
c.setStrokeColor(BLUE);c.setLineWidth(1.8);c.setDash(4,4);c.line(158,cy,433,cy);c.setDash()
c.setFillColor(white);c.roundRect(87,cy-25,70,50,5,fill=1,stroke=1);c.circle(127,cy,13,fill=0,stroke=1)
c.circle(444,cy,27,fill=1,stroke=1)
c.setFillColor(INK);c.setFont('DVB',9);c.drawCentredString(122,cy-49,'CAMERA');c.drawCentredString(444,cy-49,'MODEL')
c.setFont('DV',8);c.drawCentredString(300,cy+14,'RECORD DISTANCE + CAMERA AXIS')
c.setFillColor(BLUE);c.circle(300,cy+59,9,fill=1,stroke=0);c.setFillColor(MUTED);c.drawCentredString(300,cy+77,'RECORD LIGHT POSITION')
y-=211
y=table([['KEEP CONSISTENT','CHECK IN THE NEW FRAME'],['Subject and camera relationship','Distance, angle, height and rotation'],['Framing and view','Same intended structures, boundaries and orientation'],['Light and colour','Direction, power, white balance and references'],['Processing and file history','Comparable settings and traceable originals']],y,[207,292])
y=lines('What changed unintentionally between your first and second series?',y,2)
text('Do not attribute a difference to treatment or appearance until photographic conditions have been checked. A pleasing image is not necessarily a comparable record.',48,y,style='small');end()

y=page(5,'Module 04','Practise a view sequence.','Use a dental model. Decide the orientation and naming convention before starting. Follow the academy-approved clinical protocol only after faculty review.')
y=table([['VIEW','BEFORE YOU KEEP THE FRAME','FILE / OBSERVATION'],['Frontal model','State the intended coverage. Check alignment and focus.',''],['Right lateral model','Keep the reference convention. Check intended posterior coverage.',''],['Left lateral model','Match the opposite view as far as the purpose requires.',''],['Upper occlusal model','Show the intended arch. Check reflection, visibility and orientation.',''],['Lower occlusal model','Show the intended arch. Check reflection, visibility and orientation.','']],y,[113,236,150],[36]+[72]*5)
y=lines('Which view needed a repeat? Name the exact defect and the correction.',y,3)
text('Never guess right/left from a reflected image. Preserve the original and document any orientation correction in an authorised working copy. The sequence above is a training exercise, not a universal diagnostic series.',48,y,style='small');end()

y=page(6,'Module 05','Use a quality gate.','Rate each selected frame. A zero in any category calls for review before you use the image. This rubric is a learning aid, not a validated clinical score.')
y=table([['CRITERION','0 / REPEAT OR RESOLVE','1 / USABLE WITH NOTE','2 / PURPOSE MET'],['Purpose / coverage','Intended view missing','Coverage limitation documented','Required area visible'],['Focus / detail','Key detail unclear','Minor limitation outside key area','Required detail resolved'],['Exposure / reflections','Key information obscured','Limitation acknowledged','Required detail visible'],['Geometry / comparison','Misleading or unknown','Difference documented','Setup is reproducible'],['Identity / orientation','Uncertain or mismatched','Resolved with traceable note','Correct and traceable']],y,[99,138,128,134],[36]+[64]*5)
y=box('DECISION RULE: Do not average away a critical defect. Resolve an uncertain identity or orientation before any clinical use. Retain the original and document the decision.',y,67)
y=lines('My weakest category / corrective action / result after repeating',y,2)
text('Name the cause before changing the setup: framing, focus, movement, exposure, reflection, colour or file handling. Change one relevant factor and verify the correction.',48,y,style='small');end()

y=page(7,'Module 06','Your portfolio capstone.','Make a small, traceable practice set. Allow about 30 minutes after completing the preceding activities. Keep files locally; there is no patient-photo submission in this course.')
y=text('Your five deliverables',48,y,style='head')-12
for a,b in [('1. Setup card','Complete page 2 with the actual conditions used.'),('2. View series','Make the five model views on page 5. Use a clear naming convention.'),('3. Quality review','Apply page 6 to every selected frame. Note limitations honestly.'),('4. Before / repeat pair','Show one imperfect training frame and the result of one deliberate correction.'),('5. Short reflection','Explain what worked, what remains uncertain and what you would change next time.')]:
 y=text(a,48,y,style='head')-5;y=text(b,48,y)-19

y=lines('My naming convention and storage location (no patient identifiers)',y,2)
y=lines('The correction I can explain and reproduce',y,2)
text('Self-review checklist: every deliverable present; originals retained; orientations checked; limitations recorded; no patient data. If a faculty reviewer is available, ask for feedback on the method and the remaining limitations. No portfolio grade is issued by the platform.',48,y,style='small');end()

y=page(8,'From practice to routine','Plan the next session.','Use your findings to create a useful routine. Finishing the quiz is one checkpoint; repeatable practice is the continuing task.')
y=lines('One part of my workflow I can now explain to a colleague',y,3)
y=lines('One limitation I still need help to resolve',y,3)
y=lines('My next practice session: subject, date and one measurable aim',y,3)
y=box('BEFORE WORKING WITH PATIENTS: Confirm the purpose, applicable consent and record rules, infection-control sequence, equipment instructions and authorised storage with the academy. A model exercise does not replace supervised clinical training.',y,85)
text('Assessment reminder',48,y,style='head');y-=26
text('Complete the 12 required lessons, then attempt the 16-question post-test. Review your feedback and the relevant lesson before another attempt. If you use all three attempts, the platform supports a reasoned request for an academy-approved retake. This workbook is optional for the platform completion count but supports the practical learning outcomes.',48,y);end()

y=page(9,'Reading & provenance','Follow the source.','Original teaching exercises and diagrams accompany these primary references. Links open the underlying source. Regional professional standards are contextual examples, not a statement of local law.')
for n,r in enumerate(DATA['references'],1):
 title=escape(r['title']);url=escape(r['url'],{'"':'&quot;'})
 y=text(f'{n:02d}. <link href="{url}" color="#245AD4">{title}</link>',48,y,499,'small')-14
text('Course edition 1.0 / 13 October 2026<br/>No patient photographs or third-party figures are reproduced. Academy approval, responsible faculty and any accreditation must be established separately before public release.',48,y-8,style='small');end()
c.save()
(ROOT/'assets/courses').mkdir(parents=True,exist_ok=True)
shutil.copyfile(OUT,ROOT/'assets/courses/clinical-photography-workbook.pdf')
print(OUT)
